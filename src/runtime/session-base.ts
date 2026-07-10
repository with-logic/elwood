/** Shared adapter session behavior: lifecycle, input, command surface. Implements PRD §5.3, §5.7. */

import type { ElwoodAgentKind } from "../core/activity.ts";
import { activityFromStatus } from "../core/activity.ts";
import { ControlQueue } from "../core/control-queue.ts";
import { elwoodError } from "../core/errors.ts";
import type { ModelPickerSpec } from "../core/model-picker.ts";
import type { AgentModelOption } from "../core/model-rows.ts";
import { type PasteGuard, writePastedPrompt, writeQueuedInput } from "../core/session-input.ts";
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
  runShutdown,
  runTeardown,
  type ShutdownEvidence,
  type ShutdownHost,
} from "./session-shutdown.ts";
import { terminalStatuses } from "./session-status.ts";
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
  protected readonly controlQueue = new ControlQueue(
    (input, mode) => writeQueuedInput(this.terminal, input, mode, this.pasteGuard()),
    () => this.notRunningError(),
    () => this.submitEvidence("caller_submitted"),
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
    return this.inSession(() => {
      void writePastedPrompt(this.terminal, prompt, this.pasteGuard());
      this.submitEvidence("caller_submitted");
    });
  }
  sendMessage(message: string): Promise<void> {
    return this.inSession(() => this.controlQueue.send(message, "message"));
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
    return runShutdown(this.shutdownHost(), "SIGTERM", "stop_completed");
  }
  kill(): Promise<void> {
    return runShutdown(this.shutdownHost(), "SIGKILL", "kill_completed");
  }
  teardown(): Promise<void> {
    return runTeardown(this.shutdownHost());
  }
  private shutdownHost(): ShutdownHost {
    return {
      pty: this.pty,
      record: this.record,
      reapPolicy: this.reapPolicy,
      status: () => this.status,
      claimShutdown: (evidence) => {
        this.pendingShutdown ??= evidence;
      },
      cleanupRuntime: () => this.cleanupRuntime(),
      submitEvidence: (kind) => void this.submitEvidence(kind),
    };
  }
  submitEvidence(kind: StatusEvidenceKind): StatusDecision {
    return this.statusEngine.submit(kind);
  }
  submitExit(): StatusDecision {
    // Terminal status FIRST, reap in `finally` (C-LIFE-10): reaches terminal AND
    // reaps even if status submission throws.
    try {
      return this.statusEngine.submit(this.pendingShutdown ?? "terminal_exited");
    } finally {
      this.reapSurvivors();
    }
  }
  // Best-effort reap for the native exit callback (the ONLY swallowing caller): a
  // failure surfaces as a durable `reap_failed` warning, never thrown.
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
    const elwoodSessionId = this.elwoodSessionId;
    this.persist(updateSessionStatus(this.record, status));
    this.statusEvents.emit("status", { elwoodSessionId, status });
    this.statusEvents.emit("activity", activityFromStatus(this.agent, elwoodSessionId, status));
  }
}
