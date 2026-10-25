/**
 * In-memory Codex session object exposed to callers.
 * Implements PRD §5.7, §7A, §8, and §9.
 */

import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import type { HookObservation } from "../../core/hook-observation.ts";
import type { ModelPickerSpec } from "../../core/models/picker.ts";
import { sessionWaitForActivity, sessionWaitForStatus } from "../../core/session-wait.ts";
import { registerNativeTurnReader } from "../../core/simple/submission-context.ts";
import type { TerminalReplayBuffer } from "../../core/terminal-replay.ts";
import type { ElwoodSessionStatus, ElwoodWarningEvent } from "../../core/types.ts";
import { emitSessionWarnings } from "../../core/warnings/session.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import { PtyExitLatch } from "../../pty/exit-latch.ts";
import type { PtyProcess } from "../../pty/types.ts";
import { AgentSessionBase } from "../../runtime/session/base.ts";
import type { PersistedLoopDefinition } from "../../state/loop-store.ts";
import type { SessionRuntime } from "../../state/runtime-paths.ts";
import { type SessionRecord, updateSessionResumeId } from "../../state/store.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { codexTurnIdentity } from "../accepted-turn.ts";
import { withCodexDefault } from "../config/default-model.ts";
import { attachCodexImages } from "../images/attach.ts";
import { codexModelPicker } from "../model-picker.ts";
import { codexSessionQuestions } from "../questions/session.ts";
import { liveCodexClearance } from "../screen/live-clearance.ts";
import { createCodexRecoveryComposer } from "../screen/staged-input.ts";
import type { CodexTranscriptWatcher } from "../transcript/index.ts";
import { confirmCodexRejection } from "../transcript/rejection.ts";
import type { CodexHookBridge } from "./bridge.ts";
import { stopCodexRuntime } from "./cleanup.ts";
import { switchCodexModel } from "./config-switch.ts";
import { observeCodexInitialReady } from "./initial-ready.ts";
import { CodexTurnCommit } from "./turn-commit.ts";
import type { CodexEventHandler, CodexEventMap, CodexEventName, CodexSessionApi } from "./types.ts";
import { clipboardRestoreFailedWarning } from "./warnings.ts";

/** How long a setModel interrupted by close waits for the CLI to exit before restoring. */
const cliExitWaitMs = 5_000;

export class CodexSessionImpl extends AgentSessionBase implements CodexSessionApi {
  // The default and the setModel restore use the config fixed at THIS session's launch (§5.3).
  protected readonly picker: ModelPickerSpec = {
    ...codexModelPicker,
    isClear: liveCodexClearance(() => this.terminal),
    withDefaults: (options, signal) => withCodexDefault(options, signal, this.configPath),
  };
  private readonly bridge: CodexHookBridge;
  private readonly emitter: TypedEmitter<CodexEventMap>;
  private readonly transcriptWatcher: CodexTranscriptWatcher | undefined;
  private onInitialReady: (() => void) | undefined;
  private hookReadyObservation: HookObservation | undefined;
  // The PTY's own exit. Session status cannot stand in for it: shutdown records stopped,
  // killed, and torn_down even when its signal did not take.
  private readonly cliExit: PtyExitLatch;
  private readonly configPath: string;
  /** Holds `stop`/`teardown` for the turn a `Stop` hook ends to be recorded (C-LIFE-13). */
  readonly turnCommit = new CodexTurnCommit(
    () => this.transcriptWatcher?.poll(),
    (timeoutMs) => this.cliExit.wait(timeoutMs),
  );
  constructor(
    record: SessionRecord,
    stateDir: string,
    runtime: SessionRuntime,
    pty: PtyProcess,
    terminal: ElwoodTerminal,
    bridge: CodexHookBridge,
    emitter: TypedEmitter<CodexEventMap>,
    terminalReplay: TerminalReplayBuffer,
    transcriptWatcher: CodexTranscriptWatcher | undefined,
    loopDefinitions: readonly PersistedLoopDefinition[],
    configPath: string,
  ) {
    super(
      "codex",
      record,
      stateDir,
      runtime,
      pty,
      terminal,
      emitter,
      terminalReplay,
      loopDefinitions,
    );
    registerNativeTurnReader(this, codexTurnIdentity);
    this.configureQuestions((registry) =>
      codexSessionQuestions(registry, this.elwoodSessionId, emitter),
    );
    this.bridge = bridge;
    this.emitter = emitter;
    this.transcriptWatcher = transcriptWatcher;
    this.cliExit = new PtyExitLatch(pty);
    this.configPath = configPath;
    // Codex fires no `Stop` for a turn it rejects; its failed `task_complete` ends it (C-API-60).
    emitter.on("codex:transcript", ({ item }) => confirmCodexRejection(this, item));
    emitter.on("codex:transcript", (event) => this.turnCommit.observe(event.item));
  }

  on<E extends CodexEventName>(event: E, handler: CodexEventHandler<E>) {
    // REGISTER before replaying buffered `terminal:data` (mirrors Claude): a throwing replay
    // handler must still be subscribed for FUTURE data. Replay is synchronous, so nothing interleaves.
    const unsubscribe = this.emitter.on(event, handler);
    this.replayFor(event as string, handler);
    return unsubscribe;
  }
  override setModel(id: string, options?: { readonly timeoutMs?: number }): Promise<void> {
    // The queue slot is claimed FIRST (by `super.setModel`), and the config transaction
    // runs inside it via `around`. Reversing that let a following `sendMessage` dispatch
    // while this call was still waiting for another session's lock, sending under the old
    // model — a FIFO violation the slot exists to prevent.
    const session = {
      elwoodSessionId: this.elwoodSessionId,
      configPath: this.configPath,
      waitForCliExit: () => this.waitForCliExit(),
      emitWarnings: (warnings: readonly ElwoodWarningEvent[]) => this.emitWarnings(warnings),
    };
    return super.setModel(id, options, (flow, signal) => switchCodexModel(session, flow, signal));
  }
  // A closing session rejects the picker at once, while the dying CLI can still persist
  // the selection it had confirmed, so the restore waits on the PTY's own exit.
  private waitForCliExit(): Promise<unknown> | undefined {
    if (!this.closing.signal.aborted) return undefined;
    return this.cliExit.within(cliExitWaitMs);
  }
  off<E extends CodexEventName>(event: E, handler: CodexEventHandler<E>): void {
    this.emitter.off(event, handler);
  }
  // C-API-42 releases the queue and warns if initial-ready recording throws.
  completeInitialReady(): void {
    observeCodexInitialReady(
      this.emitter,
      this.elwoodSessionId,
      () => this.advanceInitialReady(),
      this.hookReadyObservation,
    );
  }
  waitForStatus(match: (status: ElwoodSessionStatus) => boolean, timeoutMs?: number) {
    return sessionWaitForStatus(this, match, timeoutMs);
  }
  waitForActivity(match: (event: ElwoodActivityEvent) => boolean, timeoutMs?: number) {
    return sessionWaitForActivity(this, match, timeoutMs);
  }
  // Codex has no staged chip; the composer still shows the paste's last line.
  protected readonly recoveryComposer = createCodexRecoveryComposer(this.terminal);

  // Codex ingests an interactive image only from the OS clipboard; the Ctrl+V is
  // held while a dialog is on screen so it never confirms one (C-API-46/37).
  protected attachImages = (paths: readonly string[], signal: AbortSignal): Promise<void> =>
    attachCodexImages(
      this.automatedTerminal,
      paths,
      signal,
      () => this.queuedInputBlocked(),
      () => this.emitWarnings([clipboardRestoreFailedWarning(this.elwoodSessionId)]),
    );
  rememberCodexSessionId(sessionId: string): void {
    if (this.record.codex.resumeId) return;
    this.persist(updateSessionResumeId(this.record, "codex", sessionId));
  }
  /** Registers the readiness trigger fired by the `SessionStart` hook — Codex's
   * authoritative "initialized and accepting input" signal (C-API-28). */
  setInitialReadyHook(fire: () => void): void {
    this.onInitialReady = fire;
  }
  /** Fires initial readiness from the `SessionStart` hook so the first queued
   * message is released only once Codex is actually accepting input, not on the
   * boot-time composer placeholder that would swallow it (C-API-28). */
  markInitialReadyFromHook(observation: HookObservation): void {
    const previous = this.hookReadyObservation;
    this.hookReadyObservation = observation;
    try {
      this.onInitialReady?.();
    } finally {
      this.hookReadyObservation = previous;
    }
  }
  observeTranscript(path?: string | null): void {
    if (path) this.transcriptWatcher?.observe(path);
  }
  // Queued input and loops stop at once; only the signal waits for the turn's record.
  override stop(): Promise<void> {
    this.closing.abort();
    this.loops.pause();
    return this.turnCommit.beforeShutdown(() => super.stop());
  }
  override teardown(): Promise<void> {
    this.closing.abort();
    this.loops.prepareClear();
    return this.turnCommit.beforeShutdown(() => super.teardown());
  }
  /** One bounded per-pass scan of the committed transcript (an unblocked `Stop`, §7A.3). */
  scanTranscript(): void {
    this.transcriptWatcher?.scan();
  }
  override emitWarnings(warnings: readonly ElwoodWarningEvent[]): void {
    // No cast: each callback is the emitter's own `emit` bound to a correlated
    // event name, so a map/payload drift is a compile error here.
    emitSessionWarnings(warnings, {
      warning: (event) => this.emitter.emit("warning", event),
      activity: (event) => this.emitter.emit("activity", event),
    });
  }
  protected async stopRuntime(): Promise<void> {
    await stopCodexRuntime(this.bridge, this.transcriptWatcher, this.terminal, this.pty);
  }
}
