/**
 * Shared adapter session behavior: lifecycle, input, and command surface.
 * Implements PRD §5.3 and §5.7 common session semantics.
 */

import { activityFromStatus, type ElwoodAgentKind } from "../core/activity.ts";
import { compactCommand, sessionCompact } from "../core/compact.ts";
import { ControlQueue } from "../core/control-queue.ts";
import { elwoodError } from "../core/errors.ts";
import {
  listPickerModels,
  type ModelPickerIo,
  type ModelPickerSpec,
  pickerTimeout,
  setPickerModel,
} from "../core/model-picker.ts";
import type { AgentModelOption } from "../core/model-rows.ts";
import { type PasteGuard, writePastedPrompt, writeQueuedInput } from "../core/session-input.ts";
import type { TerminalReplayBuffer } from "../core/terminal-replay.ts";
import type { ElwoodSessionStatus, ElwoodWarningEvent, TerminalSize } from "../core/types.ts";
import { replayWarningSnapshots } from "../core/warning-replay.ts";
import type { PtyProcess } from "../pty/types.ts";
import {
  removeSessionDir,
  type SessionRecord,
  updateSessionStatus,
  writeSessionRecord,
} from "../state/store.ts";
import type { ElwoodTerminal } from "../terminal/headless.ts";
import { agentTitles, type SessionStatusEmitter } from "./session-base-types.ts";
import { terminalStatuses } from "./session-status.ts";
import {
  SessionStatusEngine,
  type StatusDecision,
  type StatusEvidenceKind,
} from "./status-evidence.ts";
import { runTeardownSteps } from "./teardown.ts";
import { terminatePty } from "./terminate.ts";

type ShutdownEvidence = "stop_completed" | "kill_completed" | "teardown_completed";

export abstract class AgentSessionBase {
  protected record: SessionRecord;
  readonly terminal: ElwoodTerminal;
  protected abstract readonly picker: ModelPickerSpec;
  private readonly agent: ElwoodAgentKind;
  private readonly pty: PtyProcess;
  private readonly statusEvents: SessionStatusEmitter;
  private readonly terminalReplay: TerminalReplayBuffer;
  private cleanupPromise: Promise<void> | undefined;
  // Set before a controlled shutdown signals the PTY, so the signal-triggered
  // exit resolves to that terminal status rather than a racing `exited`.
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
    this.terminal = terminal;
    this.statusEvents = statusEvents;
    this.terminalReplay = terminalReplay;
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
      writePastedPrompt(this.terminal, prompt, this.pasteGuard());
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
    return this.inSession(() => {
      const submit = () => this.controlQueue.send(compactCommand, "compact");
      const nudge = () => this.terminal.sendInput("\r");
      return sessionCompact(this.statusEvents, submit, nudge, options?.timeoutMs);
    });
  }
  listModels(options?: { readonly timeoutMs?: number }): Promise<readonly AgentModelOption[]> {
    const io = this.pickerIo("list_models");
    return this.inSession(() => listPickerModels(io, this.picker, pickerTimeout(options)));
  }
  setModel(id: string, options?: { readonly timeoutMs?: number }): Promise<void> {
    const io = this.pickerIo("set_model");
    return this.inSession(() => setPickerModel(io, this.picker, id, pickerTimeout(options)));
  }
  stop(): Promise<void> {
    return this.shutdown("SIGTERM", "stop_completed");
  }
  kill(): Promise<void> {
    return this.shutdown("SIGKILL", "kill_completed");
  }
  async teardown(): Promise<void> {
    this.pendingShutdown ??= "teardown_completed"; // Claim the exit as teardown.
    await runTeardownSteps([
      () => (terminalStatuses.has(this.status) ? undefined : terminatePty(this.pty, "SIGKILL")),
      () => this.cleanupRuntime(),
      () => void this.submitEvidence("teardown_completed"),
      () => removeSessionDir(this.record),
    ]);
  }
  /** Submits lifecycle evidence; the engine decides whether status moves. */
  submitEvidence(kind: StatusEvidenceKind): StatusDecision {
    return this.statusEngine.submit(kind);
  }
  submitExit(): StatusDecision {
    // A controlled shutdown claims the exit; otherwise it is unsolicited.
    return this.statusEngine.submit(this.pendingShutdown ?? "terminal_exited");
  }
  /** Bounded live-only log of recent evidence decisions for diagnostics. */
  statusDecisions(): readonly StatusDecision[] {
    return this.statusEngine.decisions();
  }
  /** Whether the rendered screen still shows this prompt staged, unsubmitted. */
  protected abstract stagedPaste(screen: string, prompt: string): boolean;
  private pasteGuard(): PasteGuard {
    const staged = (s: string, p: string) => this.stagedPaste(s, p);
    return { snapshot: () => this.terminal.snapshot().text, staged };
  }
  protected abstract stopRuntime(): Promise<void>;
  protected replayFor(event: string, handler: unknown): void {
    if (event === "terminal:data") this.terminalReplay.replay(handler as never);
    replayWarningSnapshots(this.record.warnings, event, handler as (event: never) => void);
  }
  /** Rejects (never throws) after a terminal status, per C-API-25. */
  private inSession<T>(work: () => Promise<T> | T): Promise<T> {
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
  private pickerIo(kind: "list_models" | "set_model"): ModelPickerIo {
    return { terminal: this.terminal, submit: (command) => this.controlQueue.send(command, kind) };
  }
  private async shutdown(signal: "SIGTERM" | "SIGKILL", evidence: ShutdownEvidence) {
    const wasExited = this.status === "exited";
    this.pendingShutdown ??= evidence; // Claim the exit before signaling.
    if (this.status !== "exited") await terminatePty(this.pty, signal);
    await this.cleanupRuntime();
    if (!wasExited) this.submitEvidence(evidence);
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
