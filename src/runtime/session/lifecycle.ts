/** Session lifetime, input blocking, persistence and cleanup (PRD §5/§8/§9). */
import type { ElwoodActivityEvent, ElwoodAgentKind } from "../../core/activity/index.ts";
import { ControlQueue } from "../../core/control-queue/index.ts";
import { type PasteGuard, queuedInputSubmitter } from "../../core/input/index.ts";
import { registerPrivateOutputSecrets } from "../../core/private-output-secrets.ts";
import { registerTurnLoopHold } from "../../core/simple/loop-hold.ts";
import type { TerminalReplayBuffer } from "../../core/terminal-replay.ts";
import type { ElwoodSessionStatus, ElwoodWarningEvent } from "../../core/types.ts";
import type { PtyProcess } from "../../pty/types.ts";
import type { PersistedLoopDefinition } from "../../state/loop-store.ts";
import type { SessionRuntime } from "../../state/runtime-paths.ts";
import { type SessionRecord, writeSessionRecord } from "../../state/store.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { advanceInitialReady } from "../readiness/advance.ts";
import { CleanupLatch } from "../shutdown/cleanup-latch.ts";
import type {
  SessionStatusEngine,
  StatusDecision,
  StatusEvidenceKind,
} from "../status-evidence.ts";
import { observeLoopSubmissions, recordSubmission } from "./loop-boundary.ts";
import { SessionLoops } from "./loops.ts";
import { closingController, notRunningError, runSessionOperation } from "./not-running.ts";
import type { PickerInputOwnership } from "./picker-input.ts";
import { SessionReapPolicy } from "./reap.ts";
import { SessionShutdownBinding } from "./shutdown-binding.ts";
import { createSessionStatusEngine, type SessionStatusEmitter } from "./status-wiring.ts";

type TerminalDataListener = Parameters<TerminalReplayBuffer["replay"]>[0];
type AttentionListener = (event: ElwoodActivityEvent) => unknown;
export abstract class SessionLifecycle {
  protected record: SessionRecord;
  readonly terminal: ElwoodTerminal;
  protected readonly automatedTerminal: ElwoodTerminal;
  protected readonly pty: PtyProcess;
  protected readonly loops: SessionLoops;
  protected readonly controlQueue: ControlQueue;
  protected everReady = false;
  private initialReadinessHeld: (() => boolean) | undefined;
  inputBlocking = false;
  trustInputBlocking = false;
  readonly closing = closingController(() => this.controlQueue.close());
  protected readonly persist: (record: SessionRecord) => void;
  private readonly reapPolicy: SessionReapPolicy;
  private readonly terminalReplay: TerminalReplayBuffer;
  private readonly cleanupLatch = new CleanupLatch(() => this.stopRuntime());
  private readonly shutdown: SessionShutdownBinding;
  private readonly statusEngine: SessionStatusEngine;
  protected readonly pasteGuard: PasteGuard = {
    snapshot: () => this.terminal.snapshot().text,
    staged: (screen, payload) => this.stagedPaste(screen, payload),
    blocked: () => this.queuedInputBlocked(),
  };
  protected constructor(
    agent: ElwoodAgentKind,
    record: SessionRecord,
    stateDir: string,
    runtime: SessionRuntime,
    pty: PtyProcess,
    ownership: PickerInputOwnership,
    statusEvents: SessionStatusEmitter,
    terminalReplay: TerminalReplayBuffer,
    loopDefinitions: readonly PersistedLoopDefinition[],
  ) {
    registerPrivateOutputSecrets(this, [runtime.bridgeToken]);
    this.record = record;
    this.persist = (next) => {
      writeSessionRecord(next, runtime.sessionDir, runtime.stateOwnership.persistFile);
      this.record = next; // Expose metadata only after durable persistence succeeds.
    };
    this.pty = pty;
    this.terminal = ownership.caller;
    this.automatedTerminal = ownership.automated;
    this.terminalReplay = terminalReplay;
    this.reapPolicy = new SessionReapPolicy(agent, record.elwoodSessionId, pty.pid);
    const readEmpty = () => this.emptyComposerFrame();
    const blocked = () => this.queuedInputBlocked();
    const cleanup = ownership.composerCleanup(blocked, this.closing.signal, readEmpty);
    this.controlQueue = new ControlQueue(
      queuedInputSubmitter(this.automatedTerminal, this.pasteGuard),
      () => notRunningError(agent),
      (origin) => recordSubmission(this, this.loops, origin),
      () => this.status === "running",
      () => void (this.status === "ready" && this.submitEvidence("caller_submitted")),
      observeLoopSubmissions(this, statusEvents, cleanup),
    );
    registerTurnLoopHold(this, () => this.controlQueue.holdLoops());
    this.loops = new SessionLoops({
      stateDir,
      elwoodSessionId: record.elwoodSessionId,
      definitions: loopDefinitions,
      ownership: runtime.stateOwnership,
      queue: this.controlQueue,
      emitter: statusEvents,
    });
    this.statusEngine = createSessionStatusEngine({
      agent,
      elwoodSessionId: record.elwoodSessionId,
      emitter: statusEvents,
      queue: this.controlQueue,
      loops: this.loops,
      markReady: () => {
        this.everReady = true;
      },
      cleanup: () => this.cleanupLatch.float(),
    });
    this.shutdown = new SessionShutdownBinding({
      pty,
      stateDir,
      runtime,
      reapPolicy: this.reapPolicy,
      loops: this.loops,
      elwoodSessionId: () => this.elwoodSessionId,
      status: () => this.status,
      cleanupRuntime: () => this.cleanupRuntime(),
      submitEvidence: (kind) => void this.submitEvidence(kind),
    });
  }
  get elwoodSessionId(): string {
    return this.record.elwoodSessionId;
  }
  get cwd(): string {
    return this.record.cwd;
  }
  get status(): ElwoodSessionStatus {
    return this.statusEngine.status;
  }
  stop(): Promise<void> {
    this.closing.abort();
    return this.shutdown.stop();
  }
  kill(): Promise<void> {
    this.closing.abort();
    return this.shutdown.kill();
  }
  teardown(): Promise<void> {
    this.closing.abort();
    return this.shutdown.teardown();
  }
  startLoops(): void {
    this.loops.start();
  }
  pauseLoopsForStartupCleanup(cancelReadiness: () => void): void {
    this.closing.abort();
    cancelReadiness();
    this.loops.pause();
  }
  protected isInputBlocked(): boolean {
    const held = this.inputBlocking || this.trustInputBlocking;
    return this.closing.signal.aborted || held || this.status === "blocked";
  }
  bindInitialReadinessHold(isHeld: () => boolean): void {
    this.initialReadinessHeld = isHeld;
  }
  submitEvidence(kind: StatusEvidenceKind, workingVisible = false): StatusDecision {
    const held =
      this.trustInputBlocking ||
      this.closing.signal.aborted ||
      (!this.everReady && this.initialReadinessHeld?.() === true);
    return this.statusEngine.submit(kind, { inputBlocked: held, workingVisible });
  }
  submitExit(): StatusDecision {
    this.closing.abort();
    const evidence = this.shutdown.exitEvidence();
    try {
      return this.statusEngine.submit(evidence);
    } finally {
      this.shutdown.completeExitFinalization();
      const warning = evidence === "terminal_exited" ? this.reapPolicy.bestEffort() : undefined;
      if (warning) this.emitWarnings([warning]);
    }
  }
  readonly beginExitFinalization = () => this.shutdown.beginExitFinalization();
  readonly statusDecisions = (): readonly StatusDecision[] => this.statusEngine.decisions();
  protected abstract emptyComposerFrame(): object | undefined;
  protected abstract stagedPaste(screen: string, payload: string): boolean;
  protected abstract queuedInputBlocked(): boolean;
  protected abstract stopRuntime(): Promise<void>;
  protected abstract emitWarnings(warnings: readonly ElwoodWarningEvent[]): void;
  protected replayFor(event: string, handler: (event: never) => unknown): void {
    if (event === "terminal:data") this.terminalReplay.replay(handler as TerminalDataListener);
    if (event === "activity") this.terminalReplay.replayAttention(handler as AttentionListener);
  }
  protected inSession<T>(work: () => Promise<T> | T, allowTerminal = false): Promise<T> {
    return runSessionOperation(this.record.adapter, this.status, work, allowTerminal);
  }
  protected cleanupRuntime(): Promise<void> {
    this.closing.abort();
    return this.cleanupLatch.attempt();
  }
  protected advanceInitialReady(): void {
    advanceInitialReady({
      agent: this.record.adapter,
      elwoodSessionId: this.elwoodSessionId,
      submitInitialReady: () => this.submitEvidence("initial_ready"),
      markReady: () => this.controlQueue.markReady(),
      emitWarnings: (warnings) => this.emitWarnings(warnings),
    });
  }
}
