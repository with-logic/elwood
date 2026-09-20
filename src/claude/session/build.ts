/** Builds a live ClaudeSessionApi from a record + runtime. Implements PRD §5, §6, §8, §9. */

import { defaultTerminalSize } from "../../core/defaults.ts";
import { causeDetails, elwoodError } from "../../core/errors.ts";
import { emitSettledStartupOutcomes } from "../../core/startup/write.ts";
import { TerminalReplayBuffer } from "../../core/terminal-replay.ts";
import type { ClaudeEventMap, StartClaudeOptions } from "../../core/types.ts";
import { TypedEmitter } from "../../events/emitter.ts";
import type { PtyExit } from "../../pty/types.ts";
import { loadRuntimeLoopDefinitions as loadLoops } from "../../runtime/loop-restore.ts";
import { bindStartupLifetime, createSessionFrameObserver } from "../../runtime/session/frames.ts";
import { createReadinessGate } from "../../runtime/session/readiness.ts";
import { assertStartupThenRelease, createStartupBuffer } from "../../runtime/startup/buffer.ts";
import { cleanupStartupResources, guardStartupRegion } from "../../runtime/startup/cleanup.ts";
import { secureMkdir } from "../../state/files.ts";
import type { SessionRuntime } from "../../state/runtime-paths.ts";
import { type SessionRecord, writeSessionRecord } from "../../state/store.ts";
import { attachPtyTerminal } from "../../terminal/headless.ts";
import { type ClaudePreflightWarning, preflightEvent } from "../preflight.ts";
import { ClaudeStartupPromptResponder, guardedClaudeAutomationWrite } from "../startup-prompts.ts";
import { CLAUDE_STARTUP_MIN_COLS } from "../startup-size.ts";
import { currentClaudeHookBridgeFactory } from "./bridge.ts";
import { buildClaudeHookErrorHandler, buildClaudeHookHandler } from "./hook-handler.ts";
import { ClaudeSessionImpl } from "./instance.ts";
import {
  buildClaudeObservers,
  handleClaudeExit,
  registerInitialHooks,
  spawnClaudePty,
  writeRuntimeFiles,
} from "./runtime.ts";
import { createClaudeStartupWarningGate } from "./startup-warnings.ts";
import { createTranscriptWatcher, observeTranscript } from "./transcript.ts";

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
  const loopDefinitions = resumed ? loadLoops(stateDir, record.elwoodSessionId) : [];
  writeRuntimeFiles(runtime, options);
  const emitter = new TypedEmitter<ClaudeEventMap>();
  registerInitialHooks(emitter, options.hooks);
  let session: ClaudeSessionImpl | undefined;
  // Buffer diagnostics until callers can subscribe; browser decline warnings track disposal.
  const warnGate = createClaudeStartupWarningGate(
    () => session,
    () => promptResponder.closing,
  );
  const wired = createTranscriptWatcher(record.elwoodSessionId, emitter, () => warnGate);
  const { watcher: transcriptWatcher, flushPendingWarnings, finishSafely } = wired;
  // Initial readiness is hook-backed (`InstructionsLoaded` fires `mark`); the first
  // frame arms a starvation deadline so a missing/failed hook cannot starve the queue,
  // and on resume the first composer frame also marks ready (PRD §5.3, C-API-28).
  const autotrust = options.autotrust ?? false;
  // Build observers before the readiness callback captures them.
  const observers = buildClaudeObservers(record.elwoodSessionId, autotrust, emitter);
  const turnWatcher = observers.turn;
  const readiness = createReadinessGate(() => {
    turnWatcher.arm(resumed); // resume arms in settling mode (no phantom replay turn)
    // completeInitialReady advances readiness in a finally, isolating restore/warning
    // failures internally, so its promise never rejects (not awaited).
    void session?.completeInitialReady();
  }, resumed);
  const { ready } = readiness;
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
  terminalReplay.captureStartupAttention(emitter);
  const frameObserver = createSessionFrameObserver(
    observers,
    () => session,
    () => promptResponder,
    readiness,
  );
  const promptResponder = new ClaudeStartupPromptResponder(autotrust, frameObserver.refresh);
  let latestRenderedText = "";
  const terminal = attachPtyTerminal(startupSize, pty, (data, renderedTerminal) => {
    startupOutput.push(data);
    terminalReplay.push(data);
    latestRenderedText = renderedTerminal.snapshot().text;
    const frame = { text: latestRenderedText, title: renderedTerminal.title };
    // The write RETURNS its `sendInput` completion (no longer swallowed): the
    // responder settles the prompt and its `startup_prompt` activity only after
    // a live write fulfills. Live rejections warn/retry; disposal cancels (C-CLAUDE-16/22).
    const send = (input: string) => renderedTerminal.sendInput(input);
    const read = () => latestRenderedText;
    const guarded = guardedClaudeAutomationWrite(
      renderedTerminal,
      send,
      read,
      () => promptResponder.closing,
      promptResponder.closingSignal,
    );
    const autos = promptResponder.handle(frame.text, send, read, guarded);
    // Warning delivery is CONTAINED on the frame path: a throwing `warning`/`activity`
    // listener must never skip readiness, login detection, or terminal:data (§5.7).
    emitSettledStartupOutcomes(emitter, "claude", record.elwoodSessionId, autos, {
      emitWarnings: (warnings) => warnGate.emitWarnings(warnings),
    });
    frameObserver.observe(frame);
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
    loopDefinitions,
  );
  const active = session;
  bindStartupLifetime(active, promptResponder, ready);
  frameObserver.refresh();
  const beforeCleanup = () => active.pauseLoopsForStartupCleanup(ready.cancel);
  // Guard every live-resource step after session creation: a failure in any of them
  // tears down the now-live PTY, bridge, terminal, and watcher first (PRD §9.1, §9.4).
  await guardStartupRegion(
    async () => {
      active.startLoops();
      flushPendingWarnings(); // sink now exists: flush any early-buffered diagnostic (§5.7)
      // A hook or deadline that fired before the session existed submitted nothing
      // (evidence is `session?.`-guarded); replay it now the session can consume it.
      ready.replay();
      pty.onExit((exit) => {
        startupExit = exit;
        active.closing.abort();
        handleClaudeExit(emitter, record.elwoodSessionId, exit, finishSafely, () =>
          active.submitExit(),
        );
      });
      await assertStartupThenRelease("claude", startupOutput, () => startupExit);
      active.submitEvidence("startup_usable");
      frameObserver.blockOnceLive(active);
    },
    { before: beforeCleanup, pty, bridge, terminal, after: () => transcriptWatcher.stop() },
  );
  // Open buffered startup warnings after return so synchronous subscribers see them (C-API-14).
  if (preflightWarning !== undefined) {
    warnGate.emitWarnings([preflightEvent(record.elwoodSessionId, preflightWarning)]);
  }
  warnGate.openAfterReturn();
  terminalReplay.releaseStartupAttentionAfterReturn();
  return session;
}
