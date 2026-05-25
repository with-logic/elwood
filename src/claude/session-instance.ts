/**
 * In-memory Claude session object exposed to callers.
 * Implements PRD §4.1, §5, §6, §7, and §8.
 */

import { activityFromStatus } from "../core/activity.ts";
import { elwoodError } from "../core/errors.ts";
import type {
  ClaudeSession,
  ElwoodEventHandler,
  ElwoodEventName,
  ElwoodSessionStatus,
  ElwoodWarningEvent,
  TerminalSize,
} from "../core/types.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import type { PtyProcess } from "../pty/types.ts";
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
  private currentStatus: ElwoodSessionStatus = "starting";

  constructor(
    record: SessionRecord,
    pty: PtyProcess,
    terminal: ElwoodTerminal,
    bridge: HookBridge,
    emitter: TypedEmitter,
  ) {
    this.record = record;
    this.pty = pty;
    this.terminal = terminal;
    this.bridge = bridge;
    this.emitter = emitter;
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
    return this.emitter.on(event, handler);
  }

  off<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>): void {
    this.emitter.off(event, handler);
  }

  sendPrompt(prompt: string): Promise<void> {
    this.ensureRunning();
    this.terminal.sendInput(`\u001b[200~${prompt}\u001b[201~\r`);
    return Promise.resolve();
  }

  sendMessage(message: string): Promise<void> {
    return this.sendPrompt(message);
  }

  sendKeys(input: string | Uint8Array): Promise<void> {
    this.ensureRunning();
    this.terminal.sendInput(input);
    return Promise.resolve();
  }

  resize(size: TerminalSize): Promise<void> {
    this.ensureRunning();
    this.terminal.resize(size);
    this.pty.resize(size);
    this.persist(updateSessionStatus({ ...this.record, terminalSize: size }, this.currentStatus));
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    await this.terminate("SIGTERM");
    await this.bridge.stop();
    this.terminal.dispose();
    this.setStatus("stopped");
  }

  async kill(): Promise<void> {
    await this.terminate("SIGKILL");
    await this.bridge.stop();
    this.terminal.dispose();
    this.setStatus("killed");
  }

  async teardown(): Promise<void> {
    await this.terminate("SIGKILL");
    await this.bridge.stop();
    this.terminal.dispose();
    removeSessionDir(this.record);
    this.currentStatus = "torn_down";
    this.emitter.emit("status", { elwoodSessionId: this.elwoodSessionId, status: "torn_down" });
    this.emitter.emit("activity", activityFromStatus("claude", this.elwoodSessionId, "torn_down"));
  }

  markRunning(): void {
    this.setStatus("running");
  }

  markReady(): void {
    this.setStatus("ready");
  }

  markExited(): void {
    this.setStatus("exited");
  }

  rememberClaudeSessionId(sessionId: string): void {
    this.persist(updateSessionResumeId(this.record, "claude", sessionId));
  }

  private ensureRunning(): void {
    if (
      this.currentStatus === "stopped" ||
      this.currentStatus === "killed" ||
      this.currentStatus === "torn_down"
    ) {
      throw elwoodError("session_not_running", "Claude session is not running.");
    }
  }

  private setStatus(status: ElwoodSessionStatus): void {
    this.currentStatus = status;
    this.persist(updateSessionStatus(this.record, status));
    this.emitter.emit("status", { elwoodSessionId: this.elwoodSessionId, status });
    this.emitter.emit("activity", activityFromStatus("claude", this.elwoodSessionId, status));
  }

  private persist(record: SessionRecord): void {
    this.record = record;
    writeSessionRecord(record);
  }

  private async terminate(signal: string): Promise<void> {
    await new Promise<void>((resolve) => {
      const unsubscribe = this.pty.onExit(() => {
        unsubscribe();
        resolve();
      });
      this.pty.kill(signal);
      setTimeout(() => {
        unsubscribe();
        resolve();
      }, 50);
    });
  }
}
