/** Shared adapter session behavior: lifecycle, input, command surface. Implements PRD §5.3, §5.7. */

import type { ElwoodAgentKind } from "../core/activity.ts";
import { activityFromReapFailure, activityFromStatus } from "../core/activity.ts";
import { ControlQueue } from "../core/control-queue.ts";
import { elwoodError } from "../core/errors.ts";
import type { ModelPickerIo, ModelPickerSpec } from "../core/model-picker.ts";
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
import { SessionReaper } from "./reap-tree.ts";
import { agentTitles, type SessionStatusEmitter } from "./session-base-types.ts";
import { compactCommand, runCompact, runListModels, runSetModel } from "./session-commands.ts";
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
  private readonly reaper: SessionReaper;
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
    this.reaper = new SessionReaper(pty.pid);
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
    const submit = () => this.controlQueue.send(compactCommand, "compact");
    const nudge = () => this.terminal.sendInput("\r");
    return this.inSession(() => runCompact(this.statusEvents, submit, nudge, options));
  }
  listModels(options?: { readonly timeoutMs?: number }): Promise<readonly AgentModelOption[]> {
    return this.inSession(() => runListModels(this.pickerIo("list_models"), this.picker, options));
  }
  setModel(id: string, options?: { readonly timeoutMs?: number }): Promise<void> {
    return this.inSession(() => runSetModel(this.pickerIo("set_model"), this.picker, id, options));
  }
  private pickerIo(k: "list_models" | "set_model"): ModelPickerIo {
    return { terminal: this.terminal, submit: (c) => this.controlQueue.send(c, k) };
  }
  stop(): Promise<void> {
    return this.shutdown("SIGTERM", "stop_completed");
  }
  kill(): Promise<void> {
    return this.shutdown("SIGKILL", "kill_completed");
  }
  async teardown(): Promise<void> {
    this.pendingShutdown ??= "teardown_completed";
    const live = () => !terminalStatuses.has(this.status);
    await runTeardownSteps([
      () => (live() ? terminatePty(this.pty, "SIGKILL", this.reaper) : undefined),
      () => this.reaper.reap(), // No-op once latched; retries a prior failed reap.
      () => this.cleanupRuntime(),
      () => void this.submitEvidence("teardown_completed"),
      () => removeSessionDir(this.record),
    ]);
  }
  submitEvidence(kind: StatusEvidenceKind): StatusDecision {
    return this.statusEngine.submit(kind);
  }
  submitExit(): StatusDecision {
    // Terminal evidence FIRST (C-LIFE-10): exited status even if the reap fails.
    const decision = this.statusEngine.submit(this.pendingShutdown ?? "terminal_exited");
    this.reapSurvivors();
    return decision;
  }
  private reapSurvivors(): void {
    try {
      this.reaper.reap();
    } catch (e) {
      const a = activityFromReapFailure(this.agent, this.elwoodSessionId, e);
      this.statusEvents.emit("activity", a);
    }
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
  private async shutdown(signal: "SIGTERM" | "SIGKILL", evidence: ShutdownEvidence) {
    const wasExited = this.status === "exited";
    this.pendingShutdown ??= evidence; // Claim the exit before signaling.
    // Already exited: reap survivors best-effort; else terminatePty reaps + surfaces.
    if (wasExited) this.reapSurvivors();
    else await terminatePty(this.pty, signal, this.reaper);
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
