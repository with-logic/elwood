/** Builds a live CodexSessionApi from a record + runtime. Implements PRD §5.5, §5.6, §5.7, §7A, §8, §9. */
import * as activity from "../../core/activity/index.ts";
import { activityFromTerminalExit as terminalExitActivity } from "../../core/activity/index.ts";
import { AttentionWatcher } from "../../core/attention.ts";
import { defaultTerminalSize } from "../../core/defaults.ts";
import { causeDetails, elwoodError } from "../../core/errors.ts";
import { emitSettledStartupOutcomes as emitSettledStartup } from "../../core/startup/write.ts";
import { TerminalReplayBuffer } from "../../core/terminal-replay.ts";
import { TurnStateWatcher } from "../../core/turn-state.ts";
import { TypedEmitter } from "../../events/emitter.ts";
import type { PtyExit, PtyProcess } from "../../pty/types.ts";
import { loadRuntimeLoopDefinitions as loadLoops } from "../../runtime/loop-restore.ts";
import { finishSessionExit } from "../../runtime/session/exit.ts";
import { bindStartupLifetime, createSessionFrameObserver } from "../../runtime/session/frames.ts";
import { withAutomatedInput } from "../../runtime/session/picker-input.ts";
import { createReadinessGate } from "../../runtime/session/readiness.ts";
import { assertStartupThenRelease, createStartupBuffer } from "../../runtime/startup/buffer.ts";
import { cleanupStartupResources, guardStartupRegion } from "../../runtime/startup/cleanup.ts";
import { secureMkdir } from "../../state/files.ts";
import type { SessionRuntime } from "../../state/runtime-paths.ts";
import { type SessionRecord, writeSessionRecord } from "../../state/store.ts";
import { currentRenderedFrame, renderedSnapshot } from "../../terminal/cursor.ts";
import { attachPtyTerminal } from "../../terminal/headless.ts";
import type { CodexPreflightWarning } from "../preflight.ts";
import { spawnCodexPty } from "../pty.ts";
import { liveCodexClearance } from "../screen/live-clearance.ts";
import { codexScreenFactTableForTrustPolicy } from "../screen-table.ts";
import { CodexStartupPromptResponder } from "../startup-prompts.ts";
import { guardedCodexAutomationWrite } from "../update-prompt.ts";
import { currentCodexHookBridgeFactory } from "./bridge.ts";
import { reportCallerInput } from "./caller-input.ts";
import { dispatchHook, registerInitialHooks } from "./hooks.ts";
import { CodexSessionImpl } from "./instance.ts";
import { writeCodexRuntimeFiles } from "./runtime.ts";
import { createCodexStartupWarningGate, preflightEvent } from "./startup-warnings.ts";
import * as transcript from "./transcript.ts";
import type { CodexEventMap, StartCodexOptions } from "./types.ts";
import { emitUpdateAttention } from "./update-attention.ts";
export type BuildCodexSessionInput = {
  readonly record: SessionRecord;
  readonly stateDir: string;
  readonly runtime: SessionRuntime;
  readonly options: StartCodexOptions;
  readonly resumed: boolean;
  readonly activate: () => void;
  readonly preflightWarning: CodexPreflightWarning | undefined;
};
export async function buildCodexSession(input: BuildCodexSessionInput): Promise<CodexSessionImpl> {
  const { record, stateDir, runtime, options, resumed, preflightWarning } = input;
  const elwoodSessionId = record.elwoodSessionId;
  secureMkdir(runtime.sessionDir);
  writeSessionRecord(record, runtime.sessionDir, runtime.stateOwnership.publishFile);
  const loopDefinitions = resumed ? loadLoops(stateDir, record.elwoodSessionId) : [];
  writeCodexRuntimeFiles(runtime);
  const emitter = new TypedEmitter<CodexEventMap>();
  registerInitialHooks(emitter, options.hooks);
  let session: CodexSessionImpl | undefined;
  const warnGate = createCodexStartupWarningGate(
    () => session,
    () => promptResponder.closingSignal.aborted,
    (deliver) => wired.duringDelivery(deliver),
  );
  // Transcript diagnostics flow through the same startup warning gate.
  const wired = transcript.createCodexTranscriptWatcher(elwoodSessionId, emitter, () => warnGate);
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
    // Preserve the startup error while cleaning up a partially started bridge.
    await bridge.stop().catch(() => undefined);
    throw elwoodError("hook_bridge_failed", "Could not start Elwood hook bridge.", {
      ...causeDetails(error),
      socketPath: runtime.socketPath,
    });
  }
  const pty: PtyProcess = await spawnCodexPty(record, runtime.bridgeScriptPath, options).catch(
    async (error: unknown) => {
      await cleanupStartupResources({ bridge });
      throw error;
    },
  );
  const startupOutput = createStartupBuffer();
  let observedExit: PtyExit | undefined;
  const terminalReplay = new TerminalReplayBuffer(record.elwoodSessionId);
  terminalReplay.captureStartupAttention(emitter);
  const readiness = createReadinessGate(() => {
    observers.turn.arm(resumed); // resume arms in settling mode (no phantom replay turn)
    session?.completeInitialReady(); // shared anti-starvation ready boundary (C-API-42)
  }, resumed);
  const clearance = liveCodexClearance(() => terminal);
  const snapshot = () => renderedSnapshot(terminal);
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
    frameObserver.refresh,
    clearance,
    () => activeSession.inputBlocking || activeSession.trustInputBlocking,
  );
  const terminal = attachPtyTerminal(
    options.initialSize ?? defaultTerminalSize,
    pty,
    (data, renderedTerminal) => {
      terminalReplay.push(data);
      const frame = {
        text: renderedSnapshot(renderedTerminal).text,
        title: renderedTerminal.title,
      };
      const send = (input: string) =>
        withAutomatedInput(renderedTerminal, () => callerInput.automation(input));
      const read = () => renderedSnapshot(renderedTerminal).text;
      const guarded = guardedCodexAutomationWrite(
        renderedTerminal,
        send,
        read,
        promptResponder.closingSignal,
      );
      const trustRead = () => currentRenderedFrame(renderedTerminal)?.text;
      const result = promptResponder.handle(frame.text, send, read, guarded, trustRead);
      warnGate.emitWarnings(result.warnings);
      emitSettledStartup(emitter, "codex", record.elwoodSessionId, result.outcomes, warnGate);
      frameObserver.observe(frame);
      emitUpdateAttention(emitter, record.elwoodSessionId, result.updateGeneration);
      emitter.emit("terminal:data", { elwoodSessionId: record.elwoodSessionId, data });
    },
    startupOutput.push,
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
  );
  const activeSession = session;
  bindStartupLifetime(activeSession, promptResponder, readiness);
  frameObserver.refresh();
  const beforeCleanup = () => activeSession.pauseLoopsForStartupCleanup(readiness.ready.cancel);
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
    },
    { before: beforeCleanup, pty, bridge, terminal, after: () => transcriptWatcher.stop() },
  );
  if (preflightWarning !== undefined)
    warnGate.emitWarnings([preflightEvent(elwoodSessionId, preflightWarning)]);
  warnGate.openAfterReturn();
  terminalReplay.releaseStartupAttentionAfterReturn();
  return session;
}
