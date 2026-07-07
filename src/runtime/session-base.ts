/**
 * Shared adapter session behavior: lifecycle, input, and command surface.
 * Implements PRD §5.3 and §5.7 common session semantics.
 */

import { activityFromStatus, type ElwoodAgentKind } from "../core/activity.ts";
import { compactCommand, sessionCompact } from "../core/compact.ts";
import { elwoodError } from "../core/errors.ts";
import { MessageQueue } from "../core/message-queue.ts";
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
import { canTransition, terminalStatuses } from "./session-status.ts";
import { runTeardownSteps } from "./teardown.ts";
import { terminatePty } from "./terminate.ts";

export abstract class AgentSessionBase {
  protected record: SessionRecord;
  readonly terminal: ElwoodTerminal;
  protected abstract readonly picker: ModelPickerSpec;
  private readonly agent: ElwoodAgentKind;
  private readonly pty: PtyProcess;
  private readonly statusEvents: SessionStatusEmitter;
  private readonly terminalReplay: TerminalReplayBuffer;
  private currentStatus: ElwoodSessionStatus = "starting";
  private cleanupPromise: Promise<void> | undefined;
  protected readonly messages = new MessageQueue(
    (message, mode) => writeQueuedInput(this.terminal, message, mode, this.pasteGuard()),
    () => this.notRunningError(),
    () => this.markRunning(),
  );

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
    return this.currentStatus;
  }
  get warnings(): readonly ElwoodWarningEvent[] {
    return this.record.warnings;
  }
  sendPrompt(prompt: string): Promise<void> {
    return this.inSession(() => {
      writePastedPrompt(this.terminal, prompt, this.pasteGuard());
      this.markRunning();
    });
  }
  sendMessage(message: string): Promise<void> {
    return this.inSession(() => this.messages.send(message));
  }
  sendKeys(input: string | Uint8Array): Promise<void> {
    return this.inSession(() => this.terminal.sendInput(input));
  }
  resize(size: TerminalSize): Promise<void> {
    return this.inSession(() => {
      if (this.pty.resize(size) === "closed") return;
      this.terminal.resize(size);
      this.persist(updateSessionStatus({ ...this.record, terminalSize: size }, this.currentStatus));
    });
  }
  compact(options?: { readonly timeoutMs?: number }): Promise<void> {
    return this.inSession(() => {
      const submit = () => this.messages.send(compactCommand, "command");
      const nudge = () => this.terminal.sendInput("\r");
      return sessionCompact(this.statusEvents, submit, nudge, options?.timeoutMs);
    });
  }
  listModels(options?: { readonly timeoutMs?: number }): Promise<readonly AgentModelOption[]> {
    return this.inSession(() =>
      listPickerModels(this.pickerIo(), this.picker, pickerTimeout(options)),
    );
  }
  setModel(id: string, options?: { readonly timeoutMs?: number }): Promise<void> {
    return this.inSession(() =>
      setPickerModel(this.pickerIo(), this.picker, id, pickerTimeout(options)),
    );
  }
  async stop(): Promise<void> {
    await this.shutdown("SIGTERM", "stopped");
  }
  async kill(): Promise<void> {
    await this.shutdown("SIGKILL", "killed");
  }
  async teardown(): Promise<void> {
    await runTeardownSteps([
      () => (terminalStatuses.has(this.currentStatus) ? undefined : this.terminate("SIGKILL")),
      () => this.cleanupRuntime(),
      () => {
        this.messages.close();
        this.setStatus("torn_down");
      },
      () => removeSessionDir(this.record),
    ]);
  }
  markRunning(): void {
    if (terminalStatuses.has(this.currentStatus)) return;
    this.messages.markRunning();
    this.setStatus("running");
  }
  markReady(): void {
    if (terminalStatuses.has(this.currentStatus)) return;
    this.setStatus("ready");
    this.messages.markReady();
  }
  markExited(): void {
    this.messages.close();
    this.setStatus("exited");
    void this.cleanupRuntime();
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
    if (terminalStatuses.has(this.currentStatus)) return Promise.reject(this.notRunningError());
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
  private pickerIo(): ModelPickerIo {
    return { terminal: this.terminal, submit: (command) => this.messages.send(command, "command") };
  }
  private async shutdown(signal: "SIGTERM" | "SIGKILL", status: "stopped" | "killed") {
    const wasExited = this.currentStatus === "exited";
    await this.terminate(signal);
    await this.cleanupRuntime();
    if (wasExited) return;
    this.messages.close();
    this.setStatus(status);
  }
  private notRunningError(): Error {
    return elwoodError("session_not_running", `${agentTitles[this.agent]} session is not running.`);
  }
  private setStatus(status: ElwoodSessionStatus): void {
    if (!canTransition(this.currentStatus, status)) return;
    this.currentStatus = status;
    this.persist(updateSessionStatus(this.record, status));
    this.statusEvents.emit("status", { elwoodSessionId: this.elwoodSessionId, status });
    this.statusEvents.emit(
      "activity",
      activityFromStatus(this.agent, this.elwoodSessionId, status),
    );
  }
  private async terminate(signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    if (this.currentStatus === "exited") return;
    await terminatePty(this.pty, signal);
  }
}
