/**
 * In-memory Claude session object exposed to callers.
 * Implements PRD §4.1, §5, §6, §7, and §8.
 */

import { elwoodError } from "../core/errors.ts";
import type {
  ClaudeSession,
  ElwoodEventHandler,
  ElwoodEventName,
  ElwoodSessionStatus,
  TerminalSize,
} from "../core/types.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import type { PtyProcess } from "../pty/types.ts";
import {
  removeSessionDir,
  type SessionRecord,
  updateSessionStatus,
  writeSessionRecord,
} from "../state/store.ts";

export type HookBridge = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

export class ClaudeSessionImpl implements ClaudeSession {
  private record: SessionRecord;
  private readonly pty: PtyProcess;
  private readonly bridge: HookBridge;
  private readonly emitter: TypedEmitter;
  private currentStatus: ElwoodSessionStatus = "starting";

  constructor(record: SessionRecord, pty: PtyProcess, bridge: HookBridge, emitter: TypedEmitter) {
    this.record = record;
    this.pty = pty;
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

  on<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>) {
    return this.emitter.on(event, handler);
  }

  off<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>): void {
    this.emitter.off(event, handler);
  }

  sendPrompt(prompt: string): Promise<void> {
    this.ensureRunning();
    this.pty.write(`\u001b[200~${prompt}\u001b[201~\r`);
    return Promise.resolve();
  }

  sendKeys(input: string | Uint8Array): Promise<void> {
    this.ensureRunning();
    this.pty.write(input);
    return Promise.resolve();
  }

  resize(size: TerminalSize): Promise<void> {
    this.ensureRunning();
    this.pty.resize(size);
    this.persist(updateSessionStatus({ ...this.record, terminalSize: size }, this.currentStatus));
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    this.pty.kill("SIGTERM");
    await this.bridge.stop();
    this.setStatus("stopped");
  }

  async kill(): Promise<void> {
    this.pty.kill("SIGKILL");
    await this.bridge.stop();
    this.setStatus("killed");
  }

  async teardown(): Promise<void> {
    await this.bridge.stop();
    removeSessionDir(this.record);
    this.currentStatus = "torn_down";
    this.emitter.emit("status", { elwoodSessionId: this.elwoodSessionId, status: "torn_down" });
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
  }

  private persist(record: SessionRecord): void {
    this.record = record;
    writeSessionRecord(record);
  }
}
