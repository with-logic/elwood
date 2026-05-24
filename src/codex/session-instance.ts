/**
 * In-memory Codex session object exposed to callers.
 * Implements PRD §5.7, §7A, §8, and §9.
 */

import { activityFromStatus } from "../core/activity.ts";
import { elwoodError } from "../core/errors.ts";
import type { ElwoodSessionStatus, TerminalSize } from "../core/types.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import type { PtyProcess } from "../pty/types.ts";
import {
  removeSessionDir,
  type SessionRecord,
  updateSessionResumeId,
  updateSessionStatus,
  writeSessionRecord,
} from "../state/store.ts";
import type {
  CodexEventHandler,
  CodexEventMap,
  CodexEventName,
  CodexSession,
} from "./session-types.ts";
import type { CodexTranscriptWatcher } from "./transcript.ts";

export type CodexHookBridge = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

const terminalStatuses = new Set<ElwoodSessionStatus>(["stopped", "killed", "torn_down"]);

export class CodexSessionImpl implements CodexSession {
  private record: SessionRecord;
  private readonly pty: PtyProcess;
  private readonly bridge: CodexHookBridge;
  private readonly emitter: TypedEmitter<CodexEventMap>;
  private readonly transcriptWatcher: CodexTranscriptWatcher | undefined;
  private currentStatus: ElwoodSessionStatus = "starting";

  constructor(
    record: SessionRecord,
    pty: PtyProcess,
    bridge: CodexHookBridge,
    emitter: TypedEmitter<CodexEventMap>,
    transcriptWatcher?: CodexTranscriptWatcher,
  ) {
    this.record = record;
    this.pty = pty;
    this.bridge = bridge;
    this.emitter = emitter;
    this.transcriptWatcher = transcriptWatcher;
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

  on<E extends CodexEventName>(event: E, handler: CodexEventHandler<E>) {
    return this.emitter.on(event, handler);
  }

  off<E extends CodexEventName>(event: E, handler: CodexEventHandler<E>): void {
    this.emitter.off(event, handler);
  }

  sendPrompt(prompt: string): Promise<void> {
    this.ensureRunning();
    this.pty.write(`\u001b[200~${prompt}\u001b[201~\r`);
    return Promise.resolve();
  }

  sendMessage(message: string): Promise<void> {
    return this.sendPrompt(message);
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
    this.transcriptWatcher?.flush();
    this.transcriptWatcher?.stop();
    this.setStatus("stopped");
  }

  async kill(): Promise<void> {
    this.pty.kill("SIGKILL");
    await this.bridge.stop();
    this.transcriptWatcher?.flush();
    this.transcriptWatcher?.stop();
    this.setStatus("killed");
  }

  async teardown(): Promise<void> {
    await this.bridge.stop();
    this.transcriptWatcher?.flush();
    this.transcriptWatcher?.stop();
    removeSessionDir(this.record);
    this.currentStatus = "torn_down";
    this.emitter.emit("status", { elwoodSessionId: this.elwoodSessionId, status: "torn_down" });
    this.emitter.emit("activity", activityFromStatus("codex", this.elwoodSessionId, "torn_down"));
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

  rememberCodexSessionId(sessionId: string): void {
    this.persist(updateSessionResumeId(this.record, "codex", sessionId));
  }

  observeTranscript(path?: string | null): void {
    if (path) this.transcriptWatcher?.observe(path);
  }

  private ensureRunning(): void {
    if (terminalStatuses.has(this.currentStatus)) {
      throw elwoodError("session_not_running", "Codex session is not running.");
    }
  }

  private setStatus(status: ElwoodSessionStatus): void {
    this.currentStatus = status;
    this.persist(updateSessionStatus(this.record, status));
    this.emitter.emit("status", { elwoodSessionId: this.elwoodSessionId, status });
    this.emitter.emit("activity", activityFromStatus("codex", this.elwoodSessionId, status));
  }

  private persist(record: SessionRecord): void {
    this.record = record;
    writeSessionRecord(record);
  }
}
