/** Shared adapter session behavior: lifecycle, input, command surface. Implements PRD §5.3, §5.7. */
import type { ElwoodAgentKind } from "../core/activity.ts";
import { ControlQueue } from "../core/control-queue.ts";
import { toError } from "../core/errors.ts";
import type { SendOptions } from "../core/images/types.ts";
import type { ModelPickerSpec } from "../core/model-picker.ts";
import type { AgentModelOption } from "../core/model-rows.ts";
import { type PasteGuard, writeQueuedInput } from "../core/session-input.ts";
import type { TerminalReplayBuffer } from "../core/terminal-replay.ts";
import type { ElwoodSessionStatus, ElwoodWarningEvent, TerminalSize } from "../core/types.ts";
import { replayWarningSnapshots } from "../core/warning-replay.ts";
import type { PtyProcess } from "../pty/types.ts";
import { type SessionRecord, updateSessionStatus, writeSessionRecord } from "../state/store.ts";
import type { ElwoodTerminal } from "../terminal/headless.ts";
import { CleanupLatch } from "./cleanup-latch.ts";
import { advanceInitialReady } from "./initial-ready-advance.ts";
import { notRunningError, type SessionStatusEmitter } from "./session-base-types.ts";
import { CommandSurface } from "./session-commands.ts";
import { type AttachDriver, enqueueSubmission, type SubmitKind } from "./session-image-attach.ts";
import { SessionReapPolicy } from "./session-reap.ts";
import { applyResize, persistHeldResize, restoreHeldResize } from "./session-resize.ts";
import { buildShutdownHost, managedShutdown, type ShutdownEvidence } from "./session-shutdown.ts";
import { terminalStatuses } from "./session-status.ts";
import { ShutdownCoordinator } from "./shutdown-coordinator.ts";
import { emitStatusEvents } from "./status-emit.ts";
import type { StatusDecision, StatusEvidenceKind } from "./status-evidence.ts";
import { SessionStatusEngine } from "./status-evidence.ts";

export abstract class AgentSessionBase {
  protected record: SessionRecord;
  readonly terminal: ElwoodTerminal;
  protected abstract readonly picker: ModelPickerSpec;
  private readonly agent: ElwoodAgentKind;
  private readonly pty: PtyProcess;
  private readonly reapPolicy: SessionReapPolicy;
  private readonly commands: CommandSurface;
  private readonly statusEvents: SessionStatusEmitter;
  private readonly terminalReplay: TerminalReplayBuffer;
  private readonly cleanupLatch = new CleanupLatch(() => this.stopRuntime());
  private pendingShutdown: ShutdownEvidence | undefined;
  private everReady = false;
  private readonly shutdownCoordinator = new ShutdownCoordinator(); // join stop/kill/teardown
  private readonly pasteGuard: PasteGuard = {
    snapshot: () => this.terminal.snapshot().text,
    staged: (s, p) => this.stagedPaste(s, p),
    blocked: () => this.status === "blocked",
  };
  protected readonly controlQueue = new ControlQueue(
    (input, mode, signal) => writeQueuedInput(this.terminal, input, mode, this.pasteGuard, signal),
    () => notRunningError(this.agent),
    () => this.submitEvidence("caller_submitted"),
    () => this.status === "running",
  );
  private readonly statusEngine = new SessionStatusEngine({
    persistStatus: (status) => this.persistStatus(status),
    emitStatus: (status) =>
      emitStatusEvents(this.statusEvents, this.agent, this.elwoodSessionId, status),
    queueRunning: () => this.controlQueue.suspendReadiness(),
    queueReady: () => this.controlQueue.markReady(),
    queueBlocked: () => this.controlQueue.suspendReadiness(),
    queueClose: () => this.controlQueue.close(),
    cleanup: () => this.cleanupLatch.float(),
  });
  protected constructor(
    agent: ElwoodAgentKind,
    record: SessionRecord,
    pty: PtyProcess,
    terminal: ElwoodTerminal,
    statusEvents: SessionStatusEmitter,
    terminalReplay: TerminalReplayBuffer,
  ) {
    this.agent = agent;
    this.record = record;
    this.pty = pty;
    this.reapPolicy = new SessionReapPolicy(agent, record.elwoodSessionId, pty.pid);
    this.terminal = terminal;
    this.statusEvents = statusEvents;
    this.terminalReplay = terminalReplay;
    this.commands = new CommandSurface({
      terminal,
      statusEvents,
      status: () => this.status,
      everReady: () => this.everReady,
      picker: () => this.picker,
      submit: (command, kind) => this.controlQueue.send(command, kind),
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
  get warnings(): readonly ElwoodWarningEvent[] {
    return this.record.warnings;
  }
  protected get hasBeenReady(): boolean {
    return this.everReady;
  }
  sendPrompt = (prompt: string, options?: SendOptions) => this.enqueue(prompt, "prompt", options);
  sendMessage = (msg: string, options?: SendOptions) => this.enqueue(msg, "message", options);
  sendGuidance = (msg: string, options?: SendOptions) => this.enqueue(msg, "guidance", options);
  /** Adapter-specific native image attach, in-op, with resolved paths (C-API-44). */
  protected abstract attachImages(paths: readonly string[], signal: AbortSignal): Promise<void>;
  private enqueue(input: string, kind: SubmitKind, options?: SendOptions): Promise<void> {
    const driver: AttachDriver = (paths, signal) => this.attachImages(paths, signal);
    // inSession FIRST: terminal status wins over image validation (C-API-25/44).
    return this.inSession(() =>
      enqueueSubmission(options?.images, driver, (a) => this.controlQueue.send(input, kind, a)),
    );
  }
  sendKeys = (input: string | Uint8Array): Promise<void> =>
    this.inSession(() => this.terminal.sendInput(input));
  resize(size: TerminalSize): Promise<void> {
    return this.inSession(() => applyResize(this.pty, this.terminal, this.persistSize, size));
  }
  protected persistHeldSize(size: TerminalSize): void {
    persistHeldResize(this.pty, this.terminal, this.persistSize, size);
  }
  protected restoreHeldSize(size: TerminalSize): void {
    restoreHeldResize(this.pty, this.terminal, size);
  }
  private readonly persistSize = (size: TerminalSize) =>
    this.persist(updateSessionStatus({ ...this.record, terminalSize: size }, this.status));
  interrupt = (o?: { readonly timeoutMs?: number }) =>
    this.inSession(() => this.commands.interrupt(o));
  compact = (o?: { readonly timeoutMs?: number }) => this.inSession(() => this.commands.compact(o));
  listModels = (o?: { readonly timeoutMs?: number }): Promise<readonly AgentModelOption[]> =>
    this.inSession(() => this.commands.listModels(o));
  setModel(id: string, o?: { readonly timeoutMs?: number }): Promise<void> {
    return this.inSession(() => this.commands.setModel(id, o));
  }
  private readonly shutdown = managedShutdown(this.shutdownCoordinator, () => this.shutdownHost());
  stop = (): Promise<void> => this.shutdown.stop();
  kill = (): Promise<void> => this.shutdown.kill();
  teardown = (): Promise<void> => this.shutdown.teardown();
  private shutdownHost() {
    return buildShutdownHost({
      pty: this.pty,
      record: this.record,
      reapPolicy: this.reapPolicy,
      status: () => this.status,
      claimShutdown: (evidence) => {
        this.pendingShutdown ??= evidence;
      },
      cleanupRuntime: () => this.cleanupRuntime(),
      submitEvidence: (kind) => void this.submitEvidence(kind),
    });
  }
  submitEvidence = (kind: StatusEvidenceKind): StatusDecision => this.statusEngine.submit(kind);
  submitExit(): StatusDecision {
    try {
      return this.statusEngine.submit(this.pendingShutdown ?? "terminal_exited");
    } finally {
      const warning = this.reapPolicy.bestEffort(); // durable `reap_failed` warning, never a throw
      if (warning) this.recordWarnings([warning]);
    }
  }
  statusDecisions = (): readonly StatusDecision[] => this.statusEngine.decisions();
  protected abstract stagedPaste(screen: string, prompt: string): boolean;
  protected abstract stopRuntime(): Promise<void>;
  protected abstract recordWarnings(warnings: readonly ElwoodWarningEvent[]): void;
  protected replayFor(event: string, handler: unknown): void {
    if (event === "terminal:data") this.terminalReplay.replay(handler as never);
    replayWarningSnapshots(this.record.warnings, event, handler as (event: never) => void);
  }
  protected inSession<T>(work: () => Promise<T> | T): Promise<T> {
    if (terminalStatuses.has(this.status)) return Promise.reject(notRunningError(this.agent));
    try {
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(toError(error));
    }
  }
  protected persist(record: SessionRecord): void {
    writeSessionRecord(record); // durable write FIRST, commit in-memory on success (C-CLAUDE-18)
    this.record = record;
  }
  protected cleanupRuntime(): Promise<void> {
    return this.cleanupLatch.attempt();
  }
  protected advanceInitialReady(): void {
    advanceInitialReady({
      agent: this.agent,
      elwoodSessionId: this.elwoodSessionId,
      record: this.record,
      submitInitialReady: () => this.submitEvidence("initial_ready"),
      persist: (r) => this.persist(r),
      markReady: () => this.controlQueue.markReady(),
      recordWarnings: (w) => this.recordWarnings(w),
    });
  }
  private persistStatus(status: ElwoodSessionStatus): void {
    this.everReady ||= status === "ready"; // durable persist split from emit (C-API-42)
    this.persist(updateSessionStatus(this.record, status));
  }
}
