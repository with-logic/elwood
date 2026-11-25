/** Builds a live CodexSessionApi from a record + runtime. Implements PRD §5.5, §5.6, §5.7, §7A, §8, §9. */

import { startHookBridge } from "../../bridge/start.ts";
import type * as activity from "../../core/activity/index.ts";
import { activityFromTerminalExit as terminalExitActivity } from "../../core/activity/index.ts";
import { AttentionWatcher } from "../../core/attention.ts";
import { defaultTerminalSize } from "../../core/defaults.ts";
import { emitSettledStartupOutcomes as emitSettledStartup } from "../../core/startup/write.ts";
import { TerminalReplayBuffer } from "../../core/terminal-replay.ts";
import { TurnStateWatcher } from "../../core/turn-state.ts";
import { TypedEmitter } from "../../events/emitter.ts";
import type { PtyExit } from "../../pty/types.ts";
import { loadRuntimeLoopDefinitions as loadLoops } from "../../runtime/loop-restore.ts";
import { finishSessionExit } from "../../runtime/session/exit.ts";
import { bindStartupLifetime, createSessionFrameObserver } from "../../runtime/session/frames.ts";
import { withAutomatedInput } from "../../runtime/session/session-input.ts";
import { bindTurnSubmission } from "../../runtime/session/turn-submission.ts";
import { assertStartupThenRelease, createStartupBuffer } from "../../runtime/startup/buffer.ts";
import { cleanupStartupResources, guardStartupRegion } from "../../runtime/startup/cleanup.ts";
import { secureMkdir } from "../../state/files.ts";
import { writeSessionRecord } from "../../state/store.ts";
import { cachedLiveSnapshot, settledLiveSnapshot } from "../../terminal/cursor.ts";
import { attachPtyTerminal } from "../../terminal/headless.ts";
import { spawnCodexPty } from "../pty.ts";
import { liveCodexClearance } from "../screen/live-clearance.ts";
import { codexScreenFactTableForTrustPolicy } from "../screen-table.ts";
import { CodexStartupPromptResponder } from "../startup-prompts.ts";
import { guardedCodexAutomationWrite } from "../update-prompt.ts";
import { CodexWorkspaceTrustDiscovery } from "../workspace-trust/discovery.ts";
import { currentCodexHookBridgeFactory } from "./bridge.ts";
import type { BuildCodexSessionInput } from "./build-input.ts";
import { reportCallerInput } from "./caller-input.ts";
import { buildCodexHookErrorHandler, dispatchHook, registerInitialHooks } from "./hooks.ts";
import { CodexSessionImpl } from "./instance.ts";
import { createCodexReadinessGate } from "./readiness.ts";
import { writeCodexRuntimeFiles } from "./runtime.ts";
import { createCodexStartupWarningGate, preflightEvent } from "./startup-warnings.ts";
import { bindCodexQuotaStats } from "./stats.ts";
import * as transcript from "./transcript.ts";
import type { CodexEventMap } from "./types.ts";
import { emitUpdateAttention } from "./update-attention.ts";
export async function buildCodexSession(input: BuildCodexSessionInput): Promise<CodexSessionImpl> {
  const { record, stateDir, runtime, options, resumed, preflightWarning } = input;
  const { elwoodSessionId } = record;
  secureMkdir(runtime.sessionDir);
  const publish = runtime.stateOwnership.publishFile;
  writeSessionRecord(record, runtime.sessionDir, publish);
  const files = { readFile: runtime.stateOwnership.readFile, writeFile: publish };
  const loopDefinitions = resumed ? loadLoops(stateDir, record.elwoodSessionId, files) : [];
  writeCodexRuntimeFiles(runtime);
  const emitter = new TypedEmitter<CodexEventMap>();
  registerInitialHooks(emitter, options.hooks);
  let session: CodexSessionImpl | undefined;
  const warnGate = createCodexStartupWarningGate(
    () => session,
    () => promptResponder.closingSignal.aborted,
    (deliver) => wired.duringDelivery(deliver),
  );
  const wired = transcript.createCodexTranscriptWatcher(elwoodSessionId, emitter, () => warnGate);
  const { watcher: transcriptWatcher, flushPendingWarnings, finishSafely } = wired;
  const bridge = currentCodexHookBridgeFactory()(
    runtime.socketPath,
    runtime.bridgeToken,
    record.elwoodSessionId,
    async (hook) => dispatchHook(hook, emitter, options, record, session),
    buildCodexHookErrorHandler(record, emitter, () => session),
  );
  await startHookBridge(bridge, runtime.socketPath);
  const launched = await spawnCodexPty(record, runtime, options, () =>
    wired.seedResume(runtime.sessionDir, record.codex.resumeId, runtime.stateOwnership.readFile),
  ).catch(async (error: unknown) => {
    await cleanupStartupResources({ bridge });
    throw error;
  });
  const { pty, resolveConfigPath } = launched;
  const startupOutput = createStartupBuffer({ source: pty, directory: options.launchDirectory });
  const clearance = liveCodexClearance(() => terminal);
  const dialogs: CodexWorkspaceTrustDiscovery = new CodexWorkspaceTrustDiscovery({
    elwoodSessionId,
    evidence: launched.trustEvidence,
    terminal: () => terminal,
    humanOwnedPrompt: () => promptResponder.humanOwnedPrompt,
    clearance,
  });
  let observedExit: PtyExit | undefined;
  const terminalReplay = new TerminalReplayBuffer(record.elwoodSessionId);
  terminalReplay.captureStartupAttention(emitter);
  const onReady = () => {
    dialogs.endStartup();
    observers.turn.arm(resumed); // resume arms in settling mode (no phantom replay turn)
    session?.completeInitialReady(); // shared anti-starvation ready boundary (C-API-42)
  };
  const snapshot = () => cachedLiveSnapshot(terminal);
  const readiness = createCodexReadinessGate(onReady, resumed, elwoodSessionId, warnGate, emitter);
  const observers = {
    turn: new TurnStateWatcher(),
    attention: new AttentionWatcher(),
    table: codexScreenFactTableForTrustPolicy(options.autotrust ?? false, clearance, snapshot),
    agent: "codex" as const,
    elwoodSessionId: record.elwoodSessionId,
    emitActivity: (event: activity.ElwoodActivityEvent) => emitter.emit("activity", event),
  };
  const frameObserver = createSessionFrameObserver(
    observers,
    () => session,
    () => promptResponder,
    readiness,
    clearance,
  );
  const promptResponder = new CodexStartupPromptResponder(
    record.elwoodSessionId,
    options.autotrust ?? false,
    () => dialogs.reconcileAfter(frameObserver.refresh),
    clearance,
    () => activeSession.inputBlocking || activeSession.trustInputBlocking,
  );
  const terminal = attachPtyTerminal(
    options.initialSize ?? defaultTerminalSize,
    pty,
    (data, renderedTerminal) => {
      terminalReplay.push(data);
      const { text, cols } = readiness.observeStartupFrame(renderedTerminal);
      const frame = { text, cols, title: renderedTerminal.title };
      const send = (input: string) =>
        withAutomatedInput(renderedTerminal, () => callerInput.automation(input));
      const read = () => cachedLiveSnapshot(renderedTerminal).text;
      const { closingSignal } = promptResponder;
      const guarded = guardedCodexAutomationWrite(renderedTerminal, send, read, closingSignal);
      const trustRead = () => settledLiveSnapshot(renderedTerminal)?.text;
      const result = promptResponder.handle(frame.text, send, read, guarded, trustRead);
      warnGate.emitWarnings(result.warnings);
      emitSettledStartup(emitter, "codex", record.elwoodSessionId, result.outcomes, warnGate);
      dialogs.reconcileAfter(() => frameObserver.observe(frame));
      emitUpdateAttention(emitter, record.elwoodSessionId, result.updateGeneration);
      emitter.emit("terminal:data", { elwoodSessionId: record.elwoodSessionId, data });
    },
  );
  const callerInput = reportCallerInput(terminal, () => promptResponder.endStartup(), resumed);
  session = new CodexSessionImpl(
    record,
    stateDir,
    runtime,
    pty,
    callerInput.terminal,
    bridge,
    emitter,
    terminalReplay,
    transcriptWatcher,
    loopDefinitions,
    resolveConfigPath,
    dialogs,
  );
  bindCodexQuotaStats(session, emitter);
  const activeSession = bindTurnSubmission(session, observers);
  dialogs.bind(terminal, activeSession.closing.signal);
  bindStartupLifetime(activeSession, promptResponder, readiness);
  frameObserver.refresh();
  const sessionCleanup = activeSession.startupCleanupResources(readiness.ready.cancel);
  await guardStartupRegion(
    async () => {
      activeSession.startLoops();
      flushPendingWarnings(); // inside the guard: a throwing sink tears down, not leaks (§5.4/§9.4)
      activeSession.setInitialReadyHook(() => readiness.ready.mark());
      readiness.ready.replay();
      pty.onExit((exit) => {
        if (observedExit) return;
        observedExit = exit;
        activeSession.beginExitFinalization();
        activeSession.closing.abort();
        const emitExit = () => {
          emitter.emit("terminal:exit", { elwoodSessionId, ...exit });
          emitter.emit("activity", terminalExitActivity("codex", elwoodSessionId, exit.exitCode));
        };
        const finalize = () => finishSessionExit(emitExit, () => activeSession.submitExit());
        finishSafely(() => warnGate.afterDelivery(finalize));
      });
      await assertStartupThenRelease("codex", startupOutput, () => observedExit);
      activeSession.submitEvidence("startup_usable");
      frameObserver.blockOnceLive(activeSession);
      input.activate();
      transcriptWatcher.startSeededResume();
      warnGate.emitWarnings(activeSession.rolloutLocator.onLaunchCommitted());
    },
    { ...sessionCleanup, bridge, terminal, after: () => transcriptWatcher.stop() },
  );
  if (preflightWarning !== undefined)
    warnGate.emitWarnings([preflightEvent(elwoodSessionId, preflightWarning)]);
  warnGate.openAfterReturn();
  terminalReplay.releaseStartupAttentionAfterReturn();
  return session;
}
