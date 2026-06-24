/**
 * In-memory Claude session object exposed to callers.
 * Implements PRD §4.1, §5, §6, §7, and §8.
 */

import { activityFromStatus } from "../core/activity.ts";
import { elwoodError } from "../core/errors.ts";
import { MessageQueue } from "../core/message-queue.ts";
import type { TerminalReplayBuffer } from "../core/terminal-replay.ts";
import type {
  ClaudeSession,
  ElwoodEventHandler,
  ElwoodEventName,
  ElwoodSessionStatus,
  ElwoodWarningEvent,
  TerminalSize,
} from "../core/types.ts";
import { replayWarningSnapshots } from "../core/warning-replay.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import type { PtyProcess } from "../pty/types.ts";
import { canTransition, terminalStatuses } from "../runtime/session-status.ts";
import { runTeardownSteps } from "../runtime/teardown.ts";
import { terminatePty } from "../runtime/terminate.ts";
import {
  removeSessionDir,
  type SessionRecord,
  updateSessionResumeId,
  updateSessionStatus,
  writeSessionRecord,
} from "../state/store.ts";
import type { ElwoodTerminal } from "../terminal/headless.ts";

export type HookBridge = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

export class ClaudeSessionImpl implements ClaudeSession {
  private record: SessionRecord;
  private readonly pty: PtyProcess;
  readonly terminal: ElwoodTerminal;
  private readonly bridge: HookBridge;
  private readonly emitter: TypedEmitter;
  private readonly terminalReplay: TerminalReplayBuffer;
  private currentStatus: ElwoodSessionStatus = "starting";
  private cleanupPromise: Promise<void> | undefined;
  private readonly messages = new MessageQueue(
    (message) => this.writePrompt(message),
    () => this.notRunningError(),
    () => this.markRunning(),
  );

  constructor(
    record: SessionRecord,
    pty: PtyProcess,
    terminal: ElwoodTerminal,
    bridge: HookBridge,
    emitter: TypedEmitter,
    terminalReplay: TerminalReplayBuffer,
  ) {
    this.record = record;
    this.pty = pty;
    this.terminal = terminal;
    this.bridge = bridge;
    this.emitter = emitter;
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
  on<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>) {
    if (event === "terminal:data") this.terminalReplay.replay(handler as never);
    replayWarningSnapshots(this.record.warnings, event, handler as (event: never) => void);
    const unsubscribe = this.emitter.on(event, handler);
    return unsubscribe;
  }

  off<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>): void {
    this.emitter.off(event, handler);
  }
  sendPrompt(prompt: string): Promise<void> {
    this.ensureRunning();
    this.writePrompt(prompt);
    this.markRunning();
    return Promise.resolve();
  }

  sendMessage(message: string): Promise<void> {
    this.ensureRunning();
    return this.messages.send(message);
  }
  sendKeys(input: string | Uint8Array): Promise<void> {
    this.ensureRunning();
    this.terminal.sendInput(input);
    return Promise.resolve();
  }

  resize(size: TerminalSize): Promise<void> {
    this.ensureRunning();
    if (this.pty.resize(size) === "closed") return Promise.resolve();
    this.terminal.resize(size);
    this.persist(updateSessionStatus({ ...this.record, terminalSize: size }, this.currentStatus));
    return Promise.resolve();
  }
  async stop(): Promise<void> {
    const wasExited = this.currentStatus === "exited";
    await this.terminate("SIGTERM");
    await this.cleanupRuntime();
    if (!wasExited) {
      this.messages.close();
      this.setStatus("stopped");
    }
  }
  async kill(): Promise<void> {
    const wasExited = this.currentStatus === "exited";
    await this.terminate("SIGKILL");
    await this.cleanupRuntime();
    if (!wasExited) {
      this.messages.close();
      this.setStatus("killed");
    }
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
  rememberClaudeSessionId(sessionId: string): void {
    if (this.record.claude.resumeId) return;
    this.persist(updateSessionResumeId(this.record, "claude", sessionId));
  }
  private ensureRunning(): void {
    if (terminalStatuses.has(this.currentStatus)) {
      throw this.notRunningError();
    }
  }
  private writePrompt(prompt: string): void {
    this.terminal.sendInput(`\u001b[200~${prompt}\u001b[201~\r`);
  }
  private notRunningError(): Error {
    return elwoodError("session_not_running", "Claude session is not running.");
  }
  private setStatus(status: ElwoodSessionStatus): void {
    if (!canTransition(this.currentStatus, status)) return;
    this.currentStatus = status;
    this.persist(updateSessionStatus(this.record, status));
    this.emitter.emit("status", { elwoodSessionId: this.elwoodSessionId, status });
    this.emitter.emit("activity", activityFromStatus("claude", this.elwoodSessionId, status));
  }
  private persist(record: SessionRecord): void {
    this.record = record;
    writeSessionRecord(record);
  }
  private async terminate(signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    if (this.currentStatus === "exited") return;
    await terminatePty(this.pty, signal);
  }
  private cleanupRuntime(): Promise<void> {
    this.cleanupPromise ??= this.stopRuntime();
    return this.cleanupPromise;
  }
  private async stopRuntime(): Promise<void> {
    await this.bridge.stop();
    this.terminal.dispose();
  }
}
