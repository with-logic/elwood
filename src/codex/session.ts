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
import { assertStartupThenRelease, createStartupBuffer } from "../runtime/startup-buffer.ts";
import { cleanupStartupResources, guardStartupRegion } from "../runtime/startup-cleanup.ts";
import { secureMkdir } from "../state/files.ts";
import { codexLaunchPosture, withCodexLaunch } from "../state/launch-posture.ts";
import {
  createSessionRecord,
  defaultStateDir,
  prepareStateDir,
  type SessionRecord,
  upsertSessionWarning,
  withFreshSocketPath,
  writeSessionRecord,
} from "../state/store.ts";
import { attachPtyTerminal } from "../terminal/headless.ts";
import { initialReady, markReadyOnResumeComposer } from "./initial-ready.ts";
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
    stateDir,
    cwd: options.cwd,
    id: randomUUID(),
    adapter: "codex",
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    size: options.initialSize ?? defaultTerminalSize,
    ...(options.name === undefined ? {} : { name: options.name }),
  });
  const posture = withCodexLaunch(createdRecord, codexLaunchPosture(options));
  const record =
    warning === undefined
      ? posture
      : upsertSessionWarning(posture, {
          elwoodSessionId: posture.elwoodSessionId,
          ...warning,
        }).record;
  writeSessionRecord(record);
  return queuePersonaMessage(await startCodexFromRecord(record, options), options.persona);
}
export async function startCodexFromRecord(
  storedRecord: SessionRecord,
  options: StartCodexOptions,
  resumed = false,
) {
  const record = withFreshSocketPath(storedRecord);
  secureMkdir(record.paths.sessionDir);
  writeSessionRecord(record);
  writeCodexRuntimeFiles(record);
  const emitter = new TypedEmitter<CodexEventMap>();
  registerInitialHooks(emitter, options.hooks);
  const { watcher: transcriptWatcher, flushPendingWarnings } =
    sessionTranscript.createCodexTranscriptWatcher(
      record.elwoodSessionId,
      emitter,
      () => session,
      sessionTranscript.codexTranscriptSeedFromWarnings(record.warnings), // continue counts on resume
    );
  let session: CodexSessionImpl | undefined;
  const bridge = currentCodexHookBridgeFactory()(
    record.paths.socketPath,
    record.bridgeToken,
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
      socketPath: record.paths.socketPath,
    });
  }
  let pty: Awaited<ReturnType<typeof spawnCodexPty>>;
  try {
    pty = await spawnCodexPty(record, options);
  } catch (error) {
    await cleanupStartupResources({ bridge });
    throw error;
  }
  const startupOutput = createStartupBuffer();
  let startupExit: PtyExit | undefined;
  const terminalReplay = new TerminalReplayBuffer(record.elwoodSessionId);
  const ready = initialReady(() => {
    // A resume's composer-marked readiness fires BEFORE the transcript replay
    // finishes repainting — arm in settling mode so replayed frames cannot
    // fabricate a rendered turn (see TurnStateWatcher.armForResume).
    if (resumed) {
      turnWatcher.armForResume();
    } else {
      turnWatcher.arm();
    }
    session?.submitEvidence("initial_ready");
  });
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
  const terminal = attachPtyTerminal(
    options.initialSize ?? record.terminalSize ?? defaultTerminalSize,
    pty,
    (data, renderedTerminal) => {
      startupOutput.push(data);
      terminalReplay.push(data);
      // One snapshot per render: reused for prompt automation, readiness, and
      // detection (input written here only repaints on the next callback).
      const frame = { text: renderedTerminal.snapshot().text, title: renderedTerminal.title };
      // The write RETURNS its `sendInput` completion (no longer swallowed): the
      // responder settles the prompt and its `startup_prompt` activity only after
      // the write fulfills, and a rejected write stays retryable + warns (C-CODEX-17).
      const result = promptResponder.handle(frame.text, (input) =>
        renderedTerminal.sendInput(input),
      );
      session?.recordWarnings(result.warnings);
      emitSettledStartupOutcomes(emitter, "codex", record.elwoodSessionId, result.outcomes, {
        recordWarnings: (warnings) => session?.recordWarnings(warnings),
      });
      // Hook-backed readiness + deadline fallback; on resume the first composer also marks ready (C-API-28).
      ready.armDeadline();
      const reading = observeRenderedFrame(observers, frame, session);
      markReadyOnResumeComposer(ready, resumed, reading.facts.composer_visible);
      emitter.emit("terminal:data", { elwoodSessionId: record.elwoodSessionId, data });
    },
  );
  session = new CodexSessionImpl(
    record,
    pty,
    terminal,
    bridge,
    emitter,
    terminalReplay,
    transcriptWatcher,
  );
  flushPendingWarnings(); // persist any notice buffered before the sink existed (§5.4)
  const id = record.elwoodSessionId;
  const activeSession = session;
  // ONE guarded region for every live-resource step after the session exists
  // (readiness wiring/replay, exit registration, startup assertion, startup evidence):
  // a failure in ANY of them tears down the now-live PTY, bridge, terminal, readiness
  // watcher, and transcript watcher before rethrowing (PRD §9.1, §9.4). Mirrors Claude.
  await guardStartupRegion(
    async () => {
      // The `SessionStart` hook releases the first queued message (C-API-28).
      activeSession.setInitialReadyHook(() => ready.mark());
      ready.replay();
      // C-LIFE-10: drain+emit behind an error boundary; submitExit (reaps in `finally`) always runs.
      pty.onExit((exit) => {
        startupExit = exit;
        ready.cancel();
        const drainAndEmit = () => {
          transcriptWatcher.finish();
          emitter.emit("terminal:exit", { elwoodSessionId: id, ...exit });
          emitter.emit("activity", activity.activityFromTerminalExit("codex", id, exit.exitCode));
        };
        finishCodexExit(drainAndEmit, () => activeSession.submitExit());
      });
      // Release the startup buffer once the check settles so no per-session
      // transcript lingers for the PTY handler's lifetime (§9.4).
      await assertStartupThenRelease("codex", startupOutput, () => startupExit);
      activeSession.submitEvidence("startup_usable");
    },
    { before: () => ready.cancel(), pty, bridge, terminal, after: () => transcriptWatcher.stop() },
  );
  return session;
}
