/**
 * In-memory Claude session object exposed to callers.
 * Implements PRD §4.1, §5, §6, §7, and §8.
 */

import type { ElwoodActivityEvent } from "../core/activity.ts";
import { sessionWaitForActivity, sessionWaitForStatus } from "../core/session-wait.ts";
import { recordSessionWarnings } from "../core/session-warnings.ts";
import type { TerminalReplayBuffer } from "../core/terminal-replay.ts";
import type {
  ElwoodEventHandler,
  ElwoodEventName,
  ElwoodSessionStatus,
  ElwoodWarningEvent,
  TerminalSize,
} from "../core/types.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import type { PtyProcess } from "../pty/types.ts";
import { AgentSessionBase } from "../runtime/session-base.ts";
import { terminalStatuses } from "../runtime/session-status.ts";
import { type SessionRecord, updateSessionResumeId } from "../state/store.ts";
import type { ElwoodTerminal } from "../terminal/headless.ts";
import { claudeModelPicker } from "./model-picker.ts";
import { resizeRestoreFailedWarning } from "./resize-restore.ts";
import type { ClaudeSession } from "./session-interface.ts";

export type HookBridge = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

export class ClaudeSessionImpl extends AgentSessionBase implements ClaudeSession {
  protected readonly picker = claudeModelPicker;
  private readonly bridge: HookBridge;
  private readonly emitter: TypedEmitter;
  private requestedSize: TerminalSize;
  private awaitingInitialReady = true;

  constructor(
    record: SessionRecord,
    pty: PtyProcess,
    terminal: ElwoodTerminal,
    bridge: HookBridge,
    emitter: TypedEmitter,
    terminalReplay: TerminalReplayBuffer,
    requestedSize: TerminalSize,
  ) {
    super("claude", record, pty, terminal, emitter, terminalReplay);
    this.bridge = bridge;
    this.emitter = emitter;
    this.requestedSize = requestedSize;
  }

  on<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>) {
    this.replayFor(event, handler);
    return this.emitter.on(event, handler);
  }
  off<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>): void {
    this.emitter.off(event, handler);
  }
  waitForStatus(match: (status: ElwoodSessionStatus) => boolean, timeoutMs?: number) {
    return sessionWaitForStatus(this, match, timeoutMs);
  }
  waitForActivity(match: (event: ElwoodActivityEvent) => boolean, timeoutMs?: number) {
    return sessionWaitForActivity(this, match, timeoutMs);
  }
  // Captured staged chip: "❯ [Pasted text #1 +15 lines]" (claude 2.1.201).
  protected stagedPaste(screen: string): boolean {
    return /\[Pasted text/.test(screen);
  }
  /** Hold the PHYSICAL resize until Claude's one-shot readiness transition, but
   * still DURABLY persist the requested size now, so an exit before readiness
   * resumes at the latest requested geometry rather than the bootstrap width. */
  override resize(size: TerminalSize): Promise<void> {
    this.requestedSize = size;
    if (!(this.awaitingInitialReady && !terminalStatuses.has(this.status))) {
      return super.resize(size);
    }
    // Non-terminal by the guard above: durably record the size now (unless the
    // pty is racing exit), and defer the physical resize to readiness.
    this.persistHeldSize(size);
    return Promise.resolve();
  }
  /** Restore the latest requested geometry before the ready queue drains. A real
   * (non-closed) resize failure leaves Claude at its safe bootstrap width and is
   * surfaced as a typed `resize_restore_failed` warning — never silently swallowed
   * and never reported as a success — but it still never starves queued input. */
  async completeInitialReady(): Promise<void> {
    if (!this.awaitingInitialReady) return;
    this.awaitingInitialReady = false;
    try {
      await super.resize(this.requestedSize);
    } catch (error) {
      // A closed PTY is a benign no-op handled in the base resize; reaching here
      // means a real error, so surface it durably instead of continuing silently.
      this.recordWarnings([
        resizeRestoreFailedWarning(this.elwoodSessionId, this.requestedSize, error),
      ]);
    }
    try {
      this.submitEvidence("initial_ready");
    } catch {
      // A persistence/listener failure must not leave queued input starved.
      this.controlQueue.markReady();
    }
  }
  rememberClaudeSessionId(sessionId: string): void {
    if (this.record.claude.resumeId) return;
    this.persist(updateSessionResumeId(this.record, "claude", sessionId));
  }
  override recordWarnings(warnings: readonly ElwoodWarningEvent[]): void {
    recordSessionWarnings(this.record, warnings, (record) => this.persist(record), {
      warning: (event) => this.emitter.emit("warning", event),
      activity: (event) => this.emitter.emit("activity", event),
    });
  }
  protected async stopRuntime(): Promise<void> {
    await this.bridge.stop();
    this.terminal.dispose();
  }
}
