/** Builds a live ClaudeSessionApi from a record + runtime. Implements PRD §5, §6, §8, §9. */
import { defaultTerminalSize } from "../../core/defaults.ts";
import { emitSettledStartupOutcomes } from "../../core/startup/write.ts";
import { TerminalReplayBuffer } from "../../core/terminal-replay.ts";
import type { ClaudeEventMap } from "../../core/types.ts";
import { TypedEmitter } from "../../events/emitter.ts";
import type { PtyExit } from "../../pty/types.ts";
import { loadRuntimeLoopDefinitions as loadLoops } from "../../runtime/loop-restore.ts";
import { bindStartupLifetime, createSessionFrameObserver } from "../../runtime/session/frames.ts";
import { stagedInputPending, withAutomatedInput } from "../../runtime/session/session-input.ts";
import { bindTurnSubmission } from "../../runtime/session/turn-submission.ts";
import { assertStartupThenRelease, createStartupBuffer } from "../../runtime/startup/buffer.ts";
import { cleanupStartupResources, guardStartupRegion } from "../../runtime/startup/cleanup.ts";
import { secureMkdir } from "../../state/files.ts";
import { writeSessionRecord } from "../../state/store.ts";
import { settledLiveSnapshot } from "../../terminal/cursor.ts";
import { attachPtyTerminal } from "../../terminal/headless.ts";
import { liveClaudeAttentionClearance, liveClaudeIdleComposer } from "../composer/idle.ts";
import { LoginExpiringWatcher } from "../login/renewal.ts";
import { preflightEvent } from "../preflight.ts";
import { ClaudeStartupPromptResponder, guardedClaudeAutomationWrite } from "../startup-prompts.ts";
import { claudeStartupSize } from "../startup-size.ts";
import { ClaudeWorkspaceTrustEvents } from "../workspace-trust/events.ts";
import { startClaudeHookBridge } from "./bridge.ts";
import { buildClaudeHookErrorHandler, buildClaudeHookHandler } from "./hook-handler.ts";
import { ClaudeSessionImpl } from "./instance.ts";
import { createClaudeReadinessGate } from "./readiness.ts";
import {
  type BuildClaudeSessionInput,
  buildClaudeObservers,
  handleClaudeExit,
  registerInitialHooks,
  spawnClaudePty,
  writeRuntimeFiles,
} from "./runtime.ts";
import { createClaudeStartupWarningGate } from "./startup-warnings.ts";
import { createTranscriptWatcher, observeTranscript } from "./transcript.ts";
export async function buildClaudeSession(
  input: BuildClaudeSessionInput,
): Promise<ClaudeSessionImpl> {
  const { record, stateDir, runtime, options, resumed, preflightWarning } = input;
  const { elwoodSessionId } = record;
  secureMkdir(runtime.sessionDir);
  const publish = runtime.stateOwnership.publishFile;
  writeSessionRecord(record, runtime.sessionDir, publish);
  const files = { readFile: runtime.stateOwnership.readFile, writeFile: publish };
  const loopDefinitions = resumed ? loadLoops(stateDir, elwoodSessionId, files) : [];
  writeRuntimeFiles(runtime, options);
  const emitter = new TypedEmitter<ClaudeEventMap>();
  registerInitialHooks(emitter, options.hooks);
  let session: ClaudeSessionImpl | undefined;
  const warnGate = createClaudeStartupWarningGate(
    () => session,
    () => promptResponder.closing,
    (deliver) => wired.duringDelivery(deliver),
  );
  const wired = createTranscriptWatcher(elwoodSessionId, emitter, () => warnGate);
  const autotrust = options.autotrust ?? false;
  const observers = buildClaudeObservers(elwoodSessionId, autotrust, emitter);
  const idleComposerClearance = liveClaudeIdleComposer(() => terminal);
  const dialogs: ClaudeWorkspaceTrustEvents = new ClaudeWorkspaceTrustEvents(emitter, {
    elwoodSessionId,
    evidence: input.workspaceTrustEvidence,
    terminal: () => terminal,
    humanOwnedPrompt: () => promptResponder.humanOwnedPrompt,
    clearance: idleComposerClearance,
    isLive: () => session?.closing.signal.aborted === false,
    manualTrust: !autotrust,
  });
  const readiness = createClaudeReadinessGate(
    () => {
      dialogs.discovery.endStartup();
      observers.turn.arm(resumed); // resume arms in settling mode (no phantom replay turn)
      void session?.completeInitialReady();
    },
    resumed,
    { elwoodSessionId, warnings: warnGate, events: emitter, configured: idleComposerClearance },
  );
  const bridge = await startClaudeHookBridge(
    runtime.socketPath,
    runtime.bridgeToken,
    elwoodSessionId,
    buildClaudeHookHandler({
      record,
      options,
      emitter,
      transcriptWatcher: wired.watcher,
      ready: readiness.ready,
      getSession: () => session,
      getTurnWatcher: () => observers.turn,
      observeHookTranscript: (event) => observeTranscript(wired.watcher, event),
      onHookOutcome: (event, result) => session?.resolveQuestionHook(event, result),
    }),
    buildClaudeHookErrorHandler(record, emitter, () => session),
  );
  const requestedSize = options.initialSize ?? defaultTerminalSize;
  const startupSize = claudeStartupSize(requestedSize);
  let pty: ReturnType<typeof spawnClaudePty>;
  try {
    pty = spawnClaudePty(record, runtime.settingsPath, { ...options, initialSize: startupSize });
  } catch (error) {
    await cleanupStartupResources({ bridge });
    throw error;
  }
  const startupOutput = createStartupBuffer({ source: pty, directory: options.launchDirectory });
  let observedExit: PtyExit | undefined;
  const terminalReplay = new TerminalReplayBuffer(elwoodSessionId);
  terminalReplay.captureStartupAttention(emitter);
  const frameObserver = createSessionFrameObserver(
    { ...observers, warnings: warnGate },
    () => session,
    () => promptResponder,
    readiness,
    liveClaudeAttentionClearance(idleComposerClearance, () => terminal, stagedInputPending),
  );
  const promptResponder = new ClaudeStartupPromptResponder(
    autotrust,
    () => dialogs.reconcileAfter(frameObserver.refresh),
    idleComposerClearance,
    dialogs.onWorkspaceTrustTakeover,
    options.probeTrust,
  );
  let latestRenderedText = "";
  const loginExpiring = new LoginExpiringWatcher();
  const terminal = attachPtyTerminal(startupSize, pty, (data, renderedTerminal) => {
    dialogs.discovery.recordConfirmation(); // A ready listener can clear the native frame.
    terminalReplay.push(data);
    const snapshot = readiness.observeStartupFrame(renderedTerminal);
    latestRenderedText = snapshot.text;
    const send = (input: string) =>
      withAutomatedInput(renderedTerminal, () => renderedTerminal.sendInput(input));
    const read = () => latestRenderedText;
    const guarded = guardedClaudeAutomationWrite(
      renderedTerminal,
      send,
      read,
      () => promptResponder.closing,
      promptResponder.closingSignal,
    );
    const readSettled = () => settledLiveSnapshot(renderedTerminal)?.text;
    const autos = promptResponder.handle(snapshot.text, send, read, guarded, readSettled);
    dialogs.reconcile();
    emitSettledStartupOutcomes(emitter, "claude", elwoodSessionId, autos, {
      emitWarnings: (warnings) => warnGate.emitWarnings(warnings),
    });
    frameObserver.observe({ text: snapshot.text, title: renderedTerminal.title });
    warnGate.emitWarnings(loginExpiring.observeFrame(snapshot, elwoodSessionId, renderedTerminal));
    session?.noteLoginExpiry(snapshot.text);
    emitter.emit("terminal:data", { elwoodSessionId, data });
  });
  session = new ClaudeSessionImpl(
    record,
    stateDir,
    runtime,
    pty,
    terminal,
    { bridge, finishTranscriptWatcher: wired.finishSafely },
    emitter,
    terminalReplay,
    requestedSize,
    loopDefinitions,
    dialogs,
  );
  const active = bindTurnSubmission(session, observers);
  dialogs.discovery.bind(terminal, active.closing.signal);
  bindStartupLifetime(active, promptResponder, readiness);
  frameObserver.refresh();
  const sessionCleanup = active.startupCleanupResources(readiness.ready.cancel);
  await guardStartupRegion(
    async () => {
      active.startLoops();
      wired.flushPendingWarnings(); // sink now exists: flush any early-buffered diagnostic (§5.7)
      readiness.ready.replay();
      pty.onExit((exit) => {
        if (observedExit) return;
        observedExit = exit;
        dialogs.discovery.nativeExit(exit);
        active.beginExitFinalization();
        active.closing.abort();
        handleClaudeExit(
          emitter,
          elwoodSessionId,
          exit,
          (afterFlush) => wired.finishSafely(() => warnGate.afterDelivery(afterFlush)),
          () => active.submitExit(),
        );
      });
      await assertStartupThenRelease("claude", startupOutput, () => observedExit);
      active.submitEvidence("startup_usable");
      frameObserver.blockOnceLive(active);
      input.activate();
    },
    { ...sessionCleanup, bridge, terminal, after: () => wired.watcher.stop() },
  );
  if (preflightWarning !== undefined)
    warnGate.emitWarnings([preflightEvent(elwoodSessionId, preflightWarning)]);
  warnGate.openAfterReturn();
  terminalReplay.releaseStartupAttentionAfterReturn();
  return session;
}
