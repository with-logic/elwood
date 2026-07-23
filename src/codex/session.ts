/** CodexSession implementation coordinating PTY, state, and hook dispatch. Implements PRD §5.5, §5.6, §5.7, §7A, §8, and §9. */
import { randomUUID } from "node:crypto";
import * as activity from "../core/activity.ts";
import { AttentionWatcher } from "../core/attention.ts";
import { defaultTerminalSize } from "../core/defaults.ts";
import { causeDetails, elwoodError } from "../core/errors.ts";
import { queuePersonaMessage } from "../core/persona.ts";
import { observeRenderedFrame } from "../core/rendered-observers.ts";
import { emitSettledStartupOutcomes } from "../core/startup-write.ts";
import { TerminalReplayBuffer } from "../core/terminal-replay.ts";
import { TurnStateWatcher } from "../core/turn-state.ts";
import { TypedEmitter } from "../events/emitter.ts";
import type { PtyExit } from "../pty/types.ts";
import { createReadinessGate } from "../runtime/session-readiness.ts";
import { assertStartupThenRelease, createStartupBuffer } from "../runtime/startup-buffer.ts";
import { cleanupStartupResources, guardStartupRegion } from "../runtime/startup-cleanup.ts";
import { secureMkdir } from "../state/files.ts";
import { codexLaunchPosture, withCodexLaunch } from "../state/launch-posture.ts";
import { sessionRuntime } from "../state/runtime-paths.ts";
import {
  createSessionRecord,
  defaultStateDir,
  prepareStateDir,
  type SessionRecord,
  writeSessionRecord,
} from "../state/store.ts";
import { attachPtyTerminal } from "../terminal/headless.ts";
import * as preflight from "./preflight.ts";
import { spawnCodexPty } from "./pty.ts";
import { codexScreenFactTableForTrustPolicy } from "./screen-table.ts";
import { currentCodexHookBridgeFactory } from "./session-bridge.ts";
import { dispatchHook, registerInitialHooks } from "./session-hooks.ts";
import { CodexSessionImpl } from "./session-instance.ts";
import { finishCodexExit, writeCodexRuntimeFiles } from "./session-runtime.ts";
import * as sessionTranscript from "./session-transcript.ts";
import type { CodexEventMap, CodexSession, StartCodexOptions } from "./session-types.ts";
import { CodexStartupPromptResponder } from "./startup-prompts.ts";

export {
  resetCodexSessionSeamsForTests,
  setCodexHookBridgeFactoryForTests,
} from "./session-bridge.ts";
export async function startCodex(options: StartCodexOptions): Promise<CodexSession> {
  const warning = await preflight.preflightCodex(
    options.strictVersionCheck ?? false,
    options.autoupdate ?? false,
  );
  const stateDir = options.stateDir ?? defaultStateDir(options.cwd);
  prepareStateDir(stateDir, { gitignore: options.stateDir === undefined });
  const createdRecord = createSessionRecord({
    cwd: options.cwd,
    id: randomUUID(),
    adapter: "codex",
  });
  const record = withCodexLaunch(createdRecord, codexLaunchPosture(options));
  const session = await startCodexFromRecord(record, stateDir, options, false, warning);
  return queuePersonaMessage(session, options.persona);
}
export async function startCodexFromRecord(
  record: SessionRecord,
  stateDir: string,
  options: StartCodexOptions,
  resumed: boolean,
  preflightWarning: preflight.CodexPreflightWarning | undefined,
) {
  const runtime = sessionRuntime(stateDir, record.elwoodSessionId, "codex");
  secureMkdir(runtime.sessionDir);
  writeSessionRecord(record, runtime.sessionDir);
  writeCodexRuntimeFiles(runtime);
  const emitter = new TypedEmitter<CodexEventMap>();
  registerInitialHooks(emitter, options.hooks);
  const wired = sessionTranscript.createCodexTranscriptWatcher(
    record.elwoodSessionId,
    emitter,
    () => session,
  );
  const { watcher: transcriptWatcher, flushPendingWarnings, finishSafely } = wired;
  let session: CodexSessionImpl | undefined;
  const bridge = currentCodexHookBridgeFactory()(
    runtime.socketPath,
    runtime.bridgeToken,
    record.elwoodSessionId,
    async (input) => dispatchHook(input, emitter, options, record, session),
    (event) => {
      const hookError = { elwoodSessionId: record.elwoodSessionId, ...event };
      emitter.emit("hookError", hookError);
      emitter.emit("activity", activity.activityFromHookError("codex", hookError));
    },
  );
  try {
    await bridge.start();
  } catch (error) {
    throw elwoodError("hook_bridge_failed", "Could not start Elwood hook bridge.", {
      ...causeDetails(error),
      socketPath: runtime.socketPath,
    });
  }
  let pty: Awaited<ReturnType<typeof spawnCodexPty>>;
  try {
    pty = await spawnCodexPty(record, runtime.bridgeScriptPath, options);
  } catch (error) {
    await cleanupStartupResources({ bridge });
    throw error;
  }
  const startupOutput = createStartupBuffer();
  let startupExit: PtyExit | undefined;
  const terminalReplay = new TerminalReplayBuffer(record.elwoodSessionId);
  const { ready, observeReadinessFrame } = createReadinessGate(() => {
    turnWatcher.arm(resumed); // resume arms in settling mode (no phantom replay turn)
    session?.completeInitialReady(); // shared anti-starvation ready boundary (C-API-42)
  }, resumed);
  const autotrust = options.autotrust ?? false;
  const observers = {
    turn: new TurnStateWatcher(),
    attention: new AttentionWatcher(),
    table: codexScreenFactTableForTrustPolicy(autotrust),
    agent: "codex" as const,
    elwoodSessionId: record.elwoodSessionId,
    emitActivity: (event: activity.ElwoodActivityEvent) => emitter.emit("activity", event),
  };
  const turnWatcher = observers.turn;
  const promptResponder = new CodexStartupPromptResponder(record.elwoodSessionId, autotrust);
  let pendingPreflight = preflightWarning;
  const terminal = attachPtyTerminal(
    options.initialSize ?? defaultTerminalSize,
    pty,
    (data, renderedTerminal) => {
      startupOutput.push(data);
      terminalReplay.push(data);
      // Surface a preflight/version warning LIVE on the first frame the caller can
      // observe (live-only, never persisted). A one-shot so it fires exactly once.
      if (pendingPreflight !== undefined && session) {
        session.recordWarnings([{ elwoodSessionId: record.elwoodSessionId, ...pendingPreflight }]);
        pendingPreflight = undefined;
      }
      // One snapshot per render: reused for prompt automation, readiness, detection.
      const frame = { text: renderedTerminal.snapshot().text, title: renderedTerminal.title };
      // The write RETURNS its completion: the responder settles only after it fulfills;
      // a rejected write retries + warns (C-CODEX-17).
      const result = promptResponder.handle(frame.text, (input) =>
        renderedTerminal.sendInput(input),
      );
      session?.recordWarnings(result.warnings);
      emitSettledStartupOutcomes(emitter, "codex", record.elwoodSessionId, result.outcomes, {
        recordWarnings: (w) => session?.recordWarnings(w),
      });
      ready.armDeadline(); // hook/deadline readiness; resume composer also marks (C-API-28)
      const reading = observeRenderedFrame(observers, frame, session);
      observeReadinessFrame(reading.facts); // blocking gate + resume-composer mark
      emitter.emit("terminal:data", { elwoodSessionId: record.elwoodSessionId, data });
    },
  );
  session = new CodexSessionImpl(
    record,
    stateDir,
    runtime,
    pty,
    terminal,
    bridge,
    emitter,
    terminalReplay,
    transcriptWatcher,
  );
  const id = record.elwoodSessionId;
  const activeSession = session;
  // ONE guarded region for every live-resource step after the session exists (readiness
  // wiring/replay, exit registration, startup assertion/evidence): a failure in ANY tears
  // down the now-live PTY/bridge/terminal/watchers before rethrowing (§9.1/§9.4). Mirrors Claude.
  await guardStartupRegion(
    async () => {
      flushPendingWarnings(); // inside the guard: a throwing sink tears down, not leaks (§5.4/§9.4)
      // The `SessionStart` hook releases the first queued message (C-API-28).
      activeSession.setInitialReadyHook(() => ready.mark());
      ready.replay();
      // C-LIFE-10: the FINAL flush runs behind finishSafely's boundary, so a throwing
      // final-flush listener can't skip terminal:exit; submitExit always reaps last.
      pty.onExit((exit) => {
        startupExit = exit;
        ready.cancel();
        const emitExit = () => {
          emitter.emit("terminal:exit", { elwoodSessionId: id, ...exit });
          emitter.emit("activity", activity.activityFromTerminalExit("codex", id, exit.exitCode));
        };
        finishCodexExit(
          () => finishSafely(emitExit),
          () => activeSession.submitExit(),
        );
      });
      // Release the startup buffer once the check settles (no lingering transcript, §9.4).
      await assertStartupThenRelease("codex", startupOutput, () => startupExit);
      activeSession.submitEvidence("startup_usable");
    },
    { before: () => ready.cancel(), pty, bridge, terminal, after: () => transcriptWatcher.stop() },
  );
  return session;
}
