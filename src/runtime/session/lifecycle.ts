/** Session lifetime, input blocking, persistence and cleanup (PRD §5/§8/§9). */
import type { ElwoodAgentKind } from "../../core/activity/index.ts";
import type { ControlQueue } from "../../core/control-queue/index.ts";
import type { PasteGuard, RecoveryComposer } from "../../core/input/index.ts";
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
import type { StatusDecision, StatusEvidenceKind } from "../status-evidence.ts";
import { SessionLoops } from "./loops.ts";
import { bindSessionControl } from "./native-submission.ts";
import { closingController, runSessionOperation } from "./not-running.ts";
import type { PromptNormalizer, PromptSubmissions } from "./prompt-submissions.ts";
import { SessionReapPolicy } from "./reap.ts";
import type { SessionInputOwnership } from "./session-input.ts";
import { SessionShutdownBinding } from "./shutdown-binding.ts";
import { createSessionStatusEngine, type SessionStatusEmitter } from "./status-wiring.ts";
import { StopCompletion } from "./stop-completion.ts";
export abstract class SessionLifecycle {
  protected record: SessionRecord;
  readonly terminal: ElwoodTerminal;
  protected readonly automatedTerminal: ElwoodTerminal;
  protected readonly pty: PtyProcess;
  protected readonly loops: SessionLoops;
  protected readonly controlQueue: ControlQueue;
  readonly stopCompletion = new StopCompletion(this);
  readonly promptSubmissions: PromptSubmissions | undefined;
  protected everReady = false;
  private initialReadinessHold: import("./readiness.ts").InitialReadinessHold | undefined;
  inputBlocking = false;
  /** Startup automation holds input: a trust answer, or Codex's update-skip repaint (C-CODEX-27). */
  automationInputBlocking = false;
  readonly closing = closingController(() => this.controlQueue.close());
  protected readonly persist: (record: SessionRecord) => void;
  private readonly reapPolicy: SessionReapPolicy;
  private readonly terminalReplay: TerminalReplayBuffer;
  private readonly cleanupLatch = new CleanupLatch(() => this.stopRuntime());
  private readonly shutdown: SessionShutdownBinding;
  protected readonly statusEngine: ReturnType<typeof createSessionStatusEngine>;
  protected readonly pasteGuard: PasteGuard;
  /** Called during base construction. Return a normalizer without using adapter instance fields. */
  protected abstract promptNormalizer(): PromptNormalizer;
  protected constructor(
    agent: ElwoodAgentKind,
    record: SessionRecord,
    stateDir: string,
    runtime: SessionRuntime,
    pty: PtyProcess,
    input: SessionInputOwnership,
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
    this.terminal = input.caller;
    this.automatedTerminal = input.automated;
    this.terminalReplay = terminalReplay;
    this.reapPolicy = new SessionReapPolicy(agent, record.elwoodSessionId, pty.pid);
    const controls = bindSessionControl(this, input, statusEvents, {
      agent,
      resumed: record[agent].resumeId !== undefined,
      promptNormalizer: this.promptNormalizer(),
      composer: () => this.recoveryComposer,
      blocked: () => this.queuedInputBlocked(),
      readEmpty: () => this.emptyComposerFrame(),
      turnStarted: (origin) => {
        this.loops.turnStarted(origin);
        this.submitEvidence("caller_submitted");
      },
    });
    this.controlQueue = controls.controlQueue;
    this.pasteGuard = controls.pasteGuard;
    this.promptSubmissions = controls.promptSubmissions;
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
  readonly startupCleanupResources = (cancelReadiness: () => void) =>
    this.shutdown.startupCleanupResources(() => this.closing.abort(), cancelReadiness);
  protected isInputBlocked(): boolean {
    const held =
      this.inputBlocking ||
      this.automationInputBlocking ||
      (!this.everReady && this.initialReadinessHold?.holdsWrites() === true);
    return this.closing.signal.aborted || held || this.status === "blocked";
  }
  bindInitialReadinessHold(hold: import("./readiness.ts").InitialReadinessHold): void {
    this.initialReadinessHold = hold;
  }
  submitEvidence(kind: StatusEvidenceKind, workingVisible = false, cause?: string): StatusDecision {
    const held =
      this.automationInputBlocking ||
      this.closing.signal.aborted ||
      (!this.everReady && this.initialReadinessHold?.holdsReadiness() === true);
    return this.statusEngine.submit(kind, { inputBlocked: held, workingVisible, cause });
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
  protected abstract readonly recoveryComposer: RecoveryComposer;
  protected abstract queuedInputBlocked(): boolean;
  protected abstract stopRuntime(): Promise<void>;
  protected abstract emitWarnings(warnings: readonly ElwoodWarningEvent[]): void;
  protected replayFor(event: string, handler: (event: never) => unknown): void {
    this.terminalReplay.replayFor(event, handler);
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
