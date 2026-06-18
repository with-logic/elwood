/**
 * In-memory Codex session object exposed to callers.
 * Implements PRD §5.7, §7A, §8, and §9.
 */

import { activityFromStatus, activityFromWarning } from "../core/activity.ts";
import { elwoodError } from "../core/errors.ts";
import type { TerminalReplayBuffer } from "../core/terminal-replay.ts";
import type { ElwoodSessionStatus, ElwoodWarningEvent, TerminalSize } from "../core/types.ts";
import { replayWarningSnapshots } from "../core/warning-replay.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import type { PtyProcess } from "../pty/types.ts";
import { terminatePty } from "../runtime/terminate.ts";
import {
  removeSessionDir,
  type SessionRecord,
  updateSessionResumeId,
  updateSessionStatus,
  upsertSessionWarning,
  writeSessionRecord,
} from "../state/store.ts";
import type { ElwoodTerminal } from "../terminal/headless.ts";
import { stopCodexRuntime } from "./session-cleanup.ts";
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
const terminalStatuses = new Set<ElwoodSessionStatus>(["exited", "stopped", "killed", "torn_down"]);
export class CodexSessionImpl implements CodexSession {
  private record: SessionRecord;
  private readonly pty: PtyProcess;
  readonly terminal: ElwoodTerminal;
  private readonly bridge: CodexHookBridge;
  private readonly emitter: TypedEmitter<CodexEventMap>;
  private readonly terminalReplay: TerminalReplayBuffer;
  private readonly transcriptWatcher: CodexTranscriptWatcher | undefined;
  private currentStatus: ElwoodSessionStatus = "starting";
  private cleanupPromise: Promise<void> | undefined;
  constructor(
    record: SessionRecord,
    pty: PtyProcess,
    terminal: ElwoodTerminal,
    bridge: CodexHookBridge,
    emitter: TypedEmitter<CodexEventMap>,
    terminalReplay: TerminalReplayBuffer,
    transcriptWatcher?: CodexTranscriptWatcher,
  ) {
    this.record = record;
    this.pty = pty;
    this.terminal = terminal;
    this.bridge = bridge;
    this.emitter = emitter;
    this.terminalReplay = terminalReplay;
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

  get warnings(): readonly ElwoodWarningEvent[] {
    return this.record.warnings;
  }

  on<E extends CodexEventName>(event: E, handler: CodexEventHandler<E>) {
    if (event === "terminal:data") this.terminalReplay.replay(handler as never);
    replayWarningSnapshots(
      this.record.warnings,
      event as string,
      handler as (event: never) => void,
    );
    const unsubscribe = this.emitter.on(event, handler);
    return unsubscribe;
  }

  off<E extends CodexEventName>(event: E, handler: CodexEventHandler<E>): void {
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
    if (this.pty.resize(size) === "closed") return Promise.resolve();
    this.terminal.resize(size);
    this.persist(updateSessionStatus({ ...this.record, terminalSize: size }, this.currentStatus));
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    const wasExited = this.currentStatus === "exited";
    await this.terminate("SIGTERM");
    await this.cleanupRuntime();
    if (!wasExited) this.setStatus("stopped");
  }

  async kill(): Promise<void> {
    const wasExited = this.currentStatus === "exited";
    await this.terminate("SIGKILL");
    await this.cleanupRuntime();
    if (!wasExited) this.setStatus("killed");
  }

  async teardown(): Promise<void> {
    await this.terminate("SIGKILL");
    await this.cleanupRuntime();
    this.setStatus("torn_down");
    removeSessionDir(this.record);
  }

  markRunning(): void {
    this.setStatus("running");
  }

  markReady(): void {
    this.setStatus("ready");
  }

  markExited(): void {
    this.setStatus("exited");
    void this.cleanupRuntime();
  }

  rememberCodexSessionId(sessionId: string): void {
    if (this.record.codex.resumeId) return;
    this.persist(updateSessionResumeId(this.record, "codex", sessionId));
  }

  observeTranscript(path?: string | null): void {
    if (path) this.transcriptWatcher?.observe(path);
  }

  recordWarnings(warnings: readonly ElwoodWarningEvent[]): void {
    for (const warning of warnings) {
      const result = upsertSessionWarning(this.record, warning);
      this.persist(result.record);
      if (result.isNew) {
        this.emitter.emit("warning", warning);
        this.emitter.emit("activity", activityFromWarning(warning));
      }
    }
  }

  private ensureRunning(): void {
    if (terminalStatuses.has(this.currentStatus)) {
      throw elwoodError("session_not_running", "Codex session is not running.");
    }
  }

  private setStatus(status: ElwoodSessionStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.persist(updateSessionStatus(this.record, status));
    this.emitter.emit("status", { elwoodSessionId: this.elwoodSessionId, status });
    this.emitter.emit("activity", activityFromStatus("codex", this.elwoodSessionId, status));
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
    this.cleanupPromise ??= stopCodexRuntime(this.bridge, this.transcriptWatcher, this.terminal);
    return this.cleanupPromise;
  }
}
