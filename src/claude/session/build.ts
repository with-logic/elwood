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
import { currentRenderedFrame, renderedSnapshot } from "../../terminal/cursor.ts";
import { attachPtyTerminal } from "../../terminal/headless.ts";
import { type ClaudePreflightWarning, preflightEvent } from "../preflight.ts";
import { liveClaudeClearance } from "../screen-table.ts";
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
  // Readiness: cold-start hooks, resumed composer, or bounded deadline (C-API-28).
  const autotrust = options.autotrust ?? false;
  const observers = buildClaudeObservers(record.elwoodSessionId, autotrust, emitter);
  const turnWatcher = observers.turn;
  const readiness = createReadinessGate(() => {
    turnWatcher.arm(resumed); // resume arms in settling mode (no phantom replay turn)
    // completeInitialReady contains restore/warning failures and always advances readiness.
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
    // Contain partial bridge cleanup failure so the original startup error survives.
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
    liveClaudeClearance(() => terminal),
  );
  const promptResponder = new ClaudeStartupPromptResponder(
    autotrust,
    frameObserver.refresh,
    liveClaudeClearance(() => terminal),
  );
  let latestRenderedText = "";
  const terminal = attachPtyTerminal(
    startupSize,
    pty,
    (data, renderedTerminal) => {
      terminalReplay.push(data);
      latestRenderedText = renderedSnapshot(renderedTerminal).text;
      const frame = { text: latestRenderedText, title: renderedTerminal.title };
      // Settle after live writes fulfill; disposal cancels (C-CLAUDE-16/22).
      const send = (input: string) => renderedTerminal.sendInput(input);
      const read = () => latestRenderedText;
      const guarded = guardedClaudeAutomationWrite(
        renderedTerminal,
        send,
        read,
        () => promptResponder.closing,
        promptResponder.closingSignal,
      );
      const trustRead = () => currentRenderedFrame(renderedTerminal)?.text;
      const autos = promptResponder.handle(frame.text, send, read, guarded, trustRead);
      // Contain warning observers so readiness, login checks, and terminal:data run (§5.7).
      emitSettledStartupOutcomes(emitter, "claude", record.elwoodSessionId, autos, {
        emitWarnings: (warnings) => warnGate.emitWarnings(warnings),
      });
      frameObserver.observe(frame);
      // Surface a mid-session login-expiry banner once (C-CLAUDE-18); no-op pre-readiness.
      session?.noteLoginExpiry(frame.text);
      emitter.emit("terminal:data", { elwoodSessionId: record.elwoodSessionId, data });
    },
    startupOutput.push,
  );
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
  bindStartupLifetime(active, promptResponder, readiness);
  frameObserver.refresh();
  const beforeCleanup = () => active.pauseLoopsForStartupCleanup(ready.cancel);
  // Any post-construction failure tears down PTY, bridge, terminal, watcher (§9.1/§9.4).
  await guardStartupRegion(
    async () => {
      active.startLoops();
      flushPendingWarnings(); // sink now exists: flush any early-buffered diagnostic (§5.7)
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
