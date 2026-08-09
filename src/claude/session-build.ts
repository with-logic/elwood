/** Builds a live ClaudeSessionApi from a record + runtime. Implements PRD §5, §6, §8, §9. */
import { defaultTerminalSize } from "../core/defaults.ts";
import { causeDetails, elwoodError } from "../core/errors.ts";
import { observeRenderedFrame } from "../core/rendered-observers.ts";
import { createStartupWarningGate, deliverFrameWarnings } from "../core/startup-frame.ts";
import { emitSettledStartupOutcomes } from "../core/startup-write.ts";
import { TerminalReplayBuffer } from "../core/terminal-replay.ts";
import type { StartClaudeOptions } from "../core/types.ts";
import { TypedEmitter } from "../events/emitter.ts";
import type { PtyExit } from "../pty/types.ts";
import { createReadinessGate } from "../runtime/session-readiness.ts";
import { assertStartupThenRelease, createStartupBuffer } from "../runtime/startup-buffer.ts";
import { cleanupStartupResources, guardStartupRegion } from "../runtime/startup-cleanup.ts";
import { secureMkdir } from "../state/files.ts";
import type { SessionRuntime } from "../state/runtime-paths.ts";
import { type SessionRecord, writeSessionRecord } from "../state/store.ts";
import { attachPtyTerminal } from "../terminal/headless.ts";
import type { ClaudePreflightWarning } from "./preflight.ts";
import { currentClaudeHookBridgeFactory } from "./session-bridge.ts";
import { buildClaudeHookErrorHandler, buildClaudeHookHandler } from "./session-hook-handler.ts";
import { ClaudeSessionImpl } from "./session-instance.ts";
import {
  buildClaudeObservers,
  handleClaudeExit,
  registerInitialHooks,
  spawnClaudePty,
  writeRuntimeFiles,
} from "./session-runtime.ts";
import { createTranscriptWatcher, observeTranscript } from "./session-transcript.ts";
import { ClaudeStartupPromptResponder } from "./startup-prompts.ts";
import { CLAUDE_STARTUP_MIN_COLS } from "./startup-size.ts";

export type BuildClaudeSessionInput = {
  readonly record: SessionRecord;
  readonly stateDir: string;
  readonly runtime: SessionRuntime;
  readonly options: StartClaudeOptions;
  readonly resumed: boolean;
  readonly preflightWarning: ClaudePreflightWarning | undefined;
};

export async function buildClaudeSession(
  input: BuildClaudeSessionInput,
): Promise<ClaudeSessionImpl> {
  const { record, stateDir, runtime, options, resumed, preflightWarning } = input;
  secureMkdir(runtime.sessionDir);
  writeSessionRecord(record, runtime.sessionDir);
  writeRuntimeFiles(runtime, options);
  const emitter = new TypedEmitter();
  registerInitialHooks(emitter, options.hooks);
  let session: ClaudeSessionImpl | undefined;
  // ALL startup-region warnings — startup-prompt (frame path) AND transcript
  // drop/read-error diagnostics — route through ONE gate that buffers anything emitted
  // before startClaude resolves and flushes it on a deferred macrotask after return,
  // so every source stays observable without late-subscriber replay (C-API-14).
  const warnGate = createStartupWarningGate({
    emitWarnings: (w) => deliverFrameWarnings(session, w),
  });
  const wired = createTranscriptWatcher(record.elwoodSessionId, emitter, () => warnGate);
  const { watcher: transcriptWatcher, flushPendingWarnings, finishSafely } = wired;
  // Initial readiness is hook-backed (`InstructionsLoaded` fires `mark`); the first
  // frame arms a starvation deadline so a missing/failed hook cannot starve the queue,
  // and on resume the first composer frame also marks ready (PRD §5.3, C-API-28).
  const { ready, observeReadinessFrame } = createReadinessGate(() => {
    turnWatcher.arm(resumed); // resume arms in settling mode (no phantom replay turn)
    // completeInitialReady advances readiness in a finally, isolating restore/warning
    // failures internally, so its promise never rejects (not awaited).
    void session?.completeInitialReady();
  }, resumed);
  const bridge = currentClaudeHookBridgeFactory()(
    runtime.socketPath,
    runtime.bridgeToken,
    record.elwoodSessionId,
    buildClaudeHookHandler({
      record,
      options,
      emitter,
      transcriptWatcher,
      ready,
      getSession: () => session,
      getTurnWatcher: () => turnWatcher,
      observeHookTranscript: (event) => observeTranscript(transcriptWatcher, event),
    }),
    buildClaudeHookErrorHandler(record, emitter),
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
  const requestedSize = options.initialSize ?? defaultTerminalSize;
  const startupSize = {
    ...requestedSize,
    cols: Math.max(requestedSize.cols, CLAUDE_STARTUP_MIN_COLS),
  };
  let pty: ReturnType<typeof spawnClaudePty>;
  try {
    pty = spawnClaudePty(record, runtime.settingsPath, { ...options, initialSize: startupSize });
  } catch (error) {
    await cleanupStartupResources({ bridge });
    throw error;
  }
  const startupOutput = createStartupBuffer();
  let startupExit: PtyExit | undefined;
  const terminalReplay = new TerminalReplayBuffer(record.elwoodSessionId);
  const autotrust = options.autotrust ?? false;
  const promptResponder = new ClaudeStartupPromptResponder(autotrust);
  const observers = buildClaudeObservers(record.elwoodSessionId, autotrust, emitter);
  const turnWatcher = observers.turn;
  const terminal = attachPtyTerminal(startupSize, pty, (data, renderedTerminal) => {
    startupOutput.push(data);
    terminalReplay.push(data);
    const frame = { text: renderedTerminal.snapshot().text, title: renderedTerminal.title };
    // The write RETURNS its `sendInput` completion (no longer swallowed): the
    // responder settles the prompt and its `startup_prompt` activity only after
    // the write fulfills, and a rejected write stays retryable + warns (C-CLAUDE-16).
    const autos = promptResponder.handle(frame.text, (input) => renderedTerminal.sendInput(input));
    // Warning delivery is CONTAINED on the frame path: a throwing `warning`/`activity`
    // listener must never skip readiness, login detection, or terminal:data (§5.7).
    emitSettledStartupOutcomes(emitter, "claude", record.elwoodSessionId, autos, {
      emitWarnings: (warnings) => warnGate.emitWarnings(warnings),
    });
    // Hook-backed readiness + deadline fallback; on resume the first composer also marks ready (C-API-28).
    ready.armDeadline();
    const reading = observeRenderedFrame(observers, frame, session);
    observeReadinessFrame(reading.facts); // blocking gate + resume-composer mark
    // Surface a mid-session login-expiry banner once (C-CLAUDE-18); no-op pre-readiness.
    session?.noteLoginExpiry(frame.text);
    emitter.emit("terminal:data", { elwoodSessionId: record.elwoodSessionId, data });
  });
  session = new ClaudeSessionImpl(
    record,
    stateDir,
    runtime,
    pty,
    terminal,
    bridge,
    emitter,
    terminalReplay,
    requestedSize,
  );
  const active = session;
  // ONE guarded region for every live-resource step after the session exists (flush,
  // exit registration, startup assertion, startup evidence): a failure in ANY of them
  // tears down the now-live PTY, bridge, terminal, and watcher first (PRD §9.1, §9.4).
  await guardStartupRegion(
    async () => {
      flushPendingWarnings(); // sink now exists: flush any early-buffered diagnostic (§5.7)
      // A hook or deadline that fired before the session existed submitted nothing
      // (evidence is `session?.`-guarded); replay it now the session can consume it.
      ready.replay();
      pty.onExit((exit) => {
        startupExit = exit;
        ready.cancel(); // No queued message can release after exit; drop the pending deadline.
        handleClaudeExit(emitter, record.elwoodSessionId, exit, finishSafely, () =>
          active.submitExit(),
        );
      });
      // Release the startup buffer once the check settles so no per-session
      // transcript lingers for the PTY handler's lifetime (§9.4).
      await assertStartupThenRelease("claude", startupOutput, () => startupExit);
      active.submitEvidence("startup_usable");
    },
    { before: () => ready.cancel(), pty, bridge, terminal, after: () => transcriptWatcher.stop() },
  );
  // Buffer the preflight/version warning through the same gate, then open it: buffered
  // startup warnings AND the preflight flush on one deferred macrotask after return, so
  // a caller subscribing synchronously observes them all (C-API-14).
  if (preflightWarning !== undefined) {
    warnGate.emitWarnings([preflightEvent(record.elwoodSessionId, preflightWarning)]);
  }
  warnGate.openAfterReturn();
  return session;
}

// `ClaudePreflightWarning` is a DISTRIBUTED union (see DistributiveOmit), so re-attaching
// `elwoodSessionId` reconstructs each `ElwoodWarningEvent` member arm-by-arm.
type WithSessionId<W> = W extends unknown ? W & { readonly elwoodSessionId: string } : never;

function preflightEvent(
  elwoodSessionId: string,
  warning: ClaudePreflightWarning,
): WithSessionId<ClaudePreflightWarning> {
  return { elwoodSessionId, ...warning };
}
