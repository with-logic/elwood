/** Shared adapter session behavior: lifecycle, input, command surface. Implements PRD §5.3, §5.7. */
import { activityFromStatus, type ElwoodAgentKind } from "../core/activity.ts";
import { ControlQueue } from "../core/control-queue.ts";
import { elwoodError } from "../core/errors.ts";
import type { ModelPickerSpec } from "../core/model-picker.ts";
import type { AgentModelOption } from "../core/model-rows.ts";
import { type PasteGuard, writeQueuedInput } from "../core/session-input.ts";
import type { TerminalReplayBuffer } from "../core/terminal-replay.ts";
import type { ElwoodSessionStatus, ElwoodWarningEvent, TerminalSize } from "../core/types.ts";
import { replayWarningSnapshots } from "../core/warning-replay.ts";
import type { PtyProcess } from "../pty/types.ts";
import { type SessionRecord, updateSessionStatus, writeSessionRecord } from "../state/store.ts";
import type { ElwoodTerminal } from "../terminal/headless.ts";
import { agentTitles, type SessionStatusEmitter } from "./session-base-types.ts";
import { CommandSurface } from "./session-commands.ts";
import { SessionReapPolicy } from "./session-reap.ts";
import {
  buildShutdownHost,
  runManagedShutdown,
  type ShutdownEvidence,
} from "./session-shutdown.ts";
import { terminalStatuses } from "./session-status.ts";
import { ShutdownCoordinator } from "./shutdown-coordinator.ts";
import {
  SessionStatusEngine,
  type StatusDecision,
  type StatusEvidenceKind,
} from "./status-evidence.ts";

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
  private cleanupPromise: Promise<void> | undefined;
  private pendingShutdown: ShutdownEvidence | undefined;
  // Serializes stop/kill/teardown so later callers join rather than race (C-LIFE-10).
  private readonly shutdownCoordinator = new ShutdownCoordinator();
  protected readonly controlQueue = new ControlQueue(
    (input, mode) => writeQueuedInput(this.terminal, input, mode, this.pasteGuard()),
    () => this.notRunningError(),
    () => this.submitEvidence("caller_submitted"),
    () => this.status === "running",
  );
  private readonly statusEngine = new SessionStatusEngine({
    onStatus: (status) => this.emitStatus(status),
    queueRunning: () => this.controlQueue.suspendReadiness(),
    queueReady: () => this.controlQueue.markReady(),
    queueBlocked: () => this.controlQueue.suspendReadiness(),
    queueClose: () => this.controlQueue.close(),
    cleanup: () => void this.cleanupRuntime(),
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
  sendPrompt(prompt: string): Promise<void> {
    return this.inSession(() => this.controlQueue.send(prompt, "readiness_bypass"));
  }
  sendMessage(message: string): Promise<void> {
    return this.inSession(() => this.controlQueue.send(message, "message"));
  }
  sendGuidance(message: string): Promise<void> {
    return this.inSession(() => this.controlQueue.send(message, "guidance"));
  }
  sendKeys(input: string | Uint8Array): Promise<void> {
    return this.inSession(() => this.terminal.sendInput(input));
  }
  resize(size: TerminalSize): Promise<void> {
    return this.inSession(() => {
      if (this.pty.resize(size) === "closed") return;
      this.terminal.resize(size);
      this.persist(updateSessionStatus({ ...this.record, terminalSize: size }, this.status));
    });
  }
  compact(options?: { readonly timeoutMs?: number }): Promise<void> {
    return this.inSession(() => this.commands.compact(options));
  }
  listModels(options?: { readonly timeoutMs?: number }): Promise<readonly AgentModelOption[]> {
    return this.inSession(() => this.commands.listModels(options));
  }
  setModel(id: string, options?: { readonly timeoutMs?: number }): Promise<void> {
    return this.inSession(() => this.commands.setModel(id, options));
  }
  stop(): Promise<void> {
    return runManagedShutdown(this.shutdownCoordinator, "stop", () => this.shutdownHost());
  }
  kill(): Promise<void> {
    return runManagedShutdown(this.shutdownCoordinator, "kill", () => this.shutdownHost());
  }
  teardown(): Promise<void> {
    return runManagedShutdown(this.shutdownCoordinator, "teardown", () => this.shutdownHost());
  }
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
  submitEvidence(kind: StatusEvidenceKind): StatusDecision {
    return this.statusEngine.submit(kind);
  }
  submitExit(): StatusDecision {
    // Terminal status FIRST, reap in `finally`: reaches terminal AND reaps even if
    // status submission throws (C-LIFE-10).
    try {
      return this.statusEngine.submit(this.pendingShutdown ?? "terminal_exited");
    } finally {
      this.reapSurvivors();
    }
  }
  // Best-effort native-exit reap (the ONLY swallowing caller): a failure becomes a durable `reap_failed` warning, never thrown (C-LIFE-10).
  private reapSurvivors(): void {
    const warning = this.reapPolicy.bestEffort();
    if (warning) this.recordWarnings([warning]);
  }
  statusDecisions(): readonly StatusDecision[] {
    return this.statusEngine.decisions();
  }
  protected abstract stagedPaste(screen: string, prompt: string): boolean;
  private pasteGuard(): PasteGuard {
    const staged = (s: string, p: string) => this.stagedPaste(s, p);
    return { snapshot: () => this.terminal.snapshot().text, staged };
  }
  protected abstract stopRuntime(): Promise<void>;
  // Persist + emit typed warnings through the adapter's dedup/replay path; the base
  // uses it to surface a `reap_failed` diagnostic durably rather than transiently.
  protected abstract recordWarnings(warnings: readonly ElwoodWarningEvent[]): void;
  protected replayFor(event: string, handler: unknown): void {
    if (event === "terminal:data") this.terminalReplay.replay(handler as never);
    replayWarningSnapshots(this.record.warnings, event, handler as (event: never) => void);
  }
  private inSession<T>(work: () => Promise<T> | T): Promise<T> {
    // Rejects (never throws) after a terminal status (C-API-25).
    if (terminalStatuses.has(this.status)) return Promise.reject(this.notRunningError());
    return Promise.resolve(work());
  }
  protected persist(record: SessionRecord): void {
    this.record = record;
    writeSessionRecord(record);
  }
  protected cleanupRuntime(): Promise<void> {
    this.cleanupPromise ??= this.stopRuntime();
    return this.cleanupPromise;
  }
  private notRunningError(): Error {
    return elwoodError("session_not_running", `${agentTitles[this.agent]} session is not running.`);
  }
  private emitStatus(status: ElwoodSessionStatus): void {
    const id = this.elwoodSessionId;
    this.persist(updateSessionStatus(this.record, status));
    this.statusEvents.emit("status", { elwoodSessionId: id, status });
    this.statusEvents.emit("activity", activityFromStatus(this.agent, id, status));
  }
}
