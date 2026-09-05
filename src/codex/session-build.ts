/** Builds a live CodexSessionApi from a record + runtime. Implements PRD §5.5, §5.6, §5.7, §7A, §8, §9. */
import * as activity from "../core/activity.ts";
import { AttentionWatcher } from "../core/attention.ts";
import { defaultTerminalSize } from "../core/defaults.ts";
import { causeDetails, elwoodError } from "../core/errors.ts";
import { observeRenderedFrame } from "../core/rendered-observers.ts";
import { createStartupWarningGate, deliverFrameWarnings } from "../core/startup-frame.ts";
import { emitSettledStartupOutcomes } from "../core/startup-write.ts";
import { TerminalReplayBuffer } from "../core/terminal-replay.ts";
import { TurnStateWatcher } from "../core/turn-state.ts";
import { TypedEmitter } from "../events/emitter.ts";
import type { PtyExit } from "../pty/types.ts";
import { loadRuntimeLoopDefinitions as loadLoops } from "../runtime/loop-restore.ts";
import { createReadinessGate } from "../runtime/session-readiness.ts";
import { assertStartupThenRelease, createStartupBuffer } from "../runtime/startup-buffer.ts";
import { cleanupStartupResources, guardStartupRegion } from "../runtime/startup-cleanup.ts";
import { secureMkdir } from "../state/files.ts";
import type { SessionRuntime } from "../state/runtime-paths.ts";
import { type SessionRecord, writeSessionRecord } from "../state/store.ts";
import { attachPtyTerminal } from "../terminal/headless.ts";
import type { CodexPreflightWarning } from "./preflight.ts";
import { spawnCodexPty } from "./pty.ts";
import { codexScreenFactTableForTrustPolicy } from "./screen-table.ts";
import { currentCodexHookBridgeFactory } from "./session-bridge.ts";
import { dispatchHook, registerInitialHooks } from "./session-hooks.ts";
import { CodexSessionImpl } from "./session-instance.ts";
import { finishCodexExit, writeCodexRuntimeFiles } from "./session-runtime.ts";
import * as sessionTranscript from "./session-transcript.ts";
import type { CodexEventMap, StartCodexOptions } from "./session-types.ts";
import { CodexStartupPromptResponder } from "./startup-prompts.ts";

export type BuildCodexSessionInput = {
  readonly record: SessionRecord;
  readonly stateDir: string;
  readonly runtime: SessionRuntime;
  readonly options: StartCodexOptions;
  readonly resumed: boolean;
  readonly preflightWarning: CodexPreflightWarning | undefined;
};

export async function buildCodexSession(input: BuildCodexSessionInput): Promise<CodexSessionImpl> {
  const { record, stateDir, runtime, options, resumed, preflightWarning } = input;
  secureMkdir(runtime.sessionDir);
  writeSessionRecord(record, runtime.sessionDir);
  const loopDefinitions = resumed ? loadLoops(stateDir, record.elwoodSessionId) : [];
  writeCodexRuntimeFiles(runtime);
  const emitter = new TypedEmitter<CodexEventMap>();
  registerInitialHooks(emitter, options.hooks);
  let session: CodexSessionImpl | undefined;
  // ALL startup-region warnings — MCP/prompt-write (frame path) AND transcript
  // drop/read-error diagnostics — route through ONE gate that buffers anything emitted
  // before startCodex resolves and flushes it on a deferred macrotask after return, so
  // every source stays observable without late-subscriber replay (C-API-14).
  const warnGate = createStartupWarningGate({
    emitWarnings: (w) => deliverFrameWarnings(session, w),
  });
  const wired = sessionTranscript.createCodexTranscriptWatcher(
    record.elwoodSessionId,
    emitter,
    () => warnGate, // transcript diagnostics flow through the same startup gate
  );
  const { watcher: transcriptWatcher, flushPendingWarnings, finishSafely } = wired;
  const bridge = currentCodexHookBridgeFactory()(
    runtime.socketPath,
    runtime.bridgeToken,
    record.elwoodSessionId,
    async (hook) => dispatchHook(hook, emitter, options, record, session),
    (event) => {
      const hookError = { elwoodSessionId: record.elwoodSessionId, ...event };
      emitter.emit("hookError", hookError);
      emitter.emit("activity", activity.activityFromHookError("codex", hookError));
    },
  );
  try {
    await bridge.start();
  } catch (error) {
    // Best-effort shut down a partially-started bridge so its listener/socket is not
    // leaked; contained so the original bridge-start error is the one that rejects.
    await bridge.stop().catch(() => undefined);
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
  terminalReplay.captureStartupAttention(emitter);
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
  const terminal = attachPtyTerminal(
    options.initialSize ?? defaultTerminalSize,
    pty,
    (data, renderedTerminal) => {
      startupOutput.push(data);
      terminalReplay.push(data);
      // One snapshot per render: reused for prompt automation, readiness, detection.
      const frame = { text: renderedTerminal.snapshot().text, title: renderedTerminal.title };
      // The write RETURNS its completion: the responder settles only after it fulfills;
      // a rejected write retries + warns (C-CODEX-17). Warning delivery is CONTAINED on
      // the frame path so a throwing listener never skips readiness or terminal:data.
      const result = promptResponder.handle(
        frame.text,
        (i) => renderedTerminal.sendInput(i),
        () => renderedTerminal.snapshot().text,
      );
      warnGate.emitWarnings(result.warnings);
      emitSettledStartupOutcomes(emitter, "codex", record.elwoodSessionId, result.outcomes, {
        emitWarnings: (w) => warnGate.emitWarnings(w),
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
    loopDefinitions,
  );
  const id = record.elwoodSessionId;
  const activeSession = session;
  const beforeCleanup = () => activeSession.pauseLoopsForStartupCleanup(ready.cancel);
  // ONE guarded region for every live-resource step after the session exists (readiness
  // wiring/replay, exit registration, startup assertion/evidence): a failure in ANY tears
  // down the now-live PTY/bridge/terminal/watchers before rethrowing (§9.1/§9.4). Mirrors Claude.
  await guardStartupRegion(
    async () => {
      activeSession.startLoops();
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
    { before: beforeCleanup, pty, bridge, terminal, after: () => transcriptWatcher.stop() },
  );
  // Buffer the preflight/version warning through the same gate, then open it: buffered
  // startup warnings (MCP/transcript) AND the preflight all flush on one deferred
  // macrotask after return, so a caller subscribing synchronously observes them all.
  if (preflightWarning !== undefined) warnGate.emitWarnings([preflightEvent(id, preflightWarning)]);
  warnGate.openAfterReturn();
  terminalReplay.releaseStartupAttentionAfterReturn();
  return session;
}

// `CodexPreflightWarning` is a DISTRIBUTED union (see DistributiveOmit / the Claude twin), so
// re-attaching `elwoodSessionId` reconstructs each union member arm-by-arm.
type WithSessionId<W> = W extends unknown ? W & { readonly elwoodSessionId: string } : never;

function preflightEvent(
  elwoodSessionId: string,
  warning: CodexPreflightWarning,
): WithSessionId<CodexPreflightWarning> {
  return { elwoodSessionId, ...warning };
}
