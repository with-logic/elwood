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
import { CLAUDE_STARTUP_MIN_COLS } from "./startup-size.ts";

export type HookBridge = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

export class ClaudeSessionImpl extends AgentSessionBase implements ClaudeSession {
  protected readonly picker = claudeModelPicker;
  private readonly bridge: HookBridge;
  private readonly emitter: TypedEmitter;
  private requestedSize: TerminalSize;
  // Only a session requested BELOW the 100-column startup floor bootstraps wide
  // and defers its restore to readiness (C-API-36). A session requested at 100+
  // columns already starts at its exact size, so its pre-ready resizes apply
  // immediately like any other resize — nothing to hold or restore.
  private awaitingInitialReady: boolean;
  // Whether the one-shot initial-ready transition has already run (idempotent).
  private initialReadyDone = false;

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
    this.awaitingInitialReady = requestedSize.cols < CLAUDE_STARTUP_MIN_COLS;
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
  /** A narrow session holds the PHYSICAL resize until Claude's one-shot readiness
   * transition, but still DURABLY persists the requested size now so an exit before
   * readiness resumes at the latest requested geometry rather than the bootstrap
   * width. A wide session (100+ cols) never deferred, so it resizes immediately. */
  override resize(size: TerminalSize): Promise<void> {
    if (!(this.awaitingInitialReady && !terminalStatuses.has(this.status))) {
      this.requestedSize = size;
      return super.resize(size);
    }
    // Non-terminal by the guard above: durably record the size now (unless the
    // pty is racing exit), and defer the physical resize to readiness. `size`
    // becomes the requested geometry ONLY if the held persist succeeds — a
    // rejected persist (e.g. a throwing pty-liveness probe) must NOT be applied
    // at readiness, and the caller sees the rejection (C-API-25/C-API-39).
    return Promise.resolve().then(() => {
      this.persistHeldSize(size);
      this.requestedSize = size;
    });
  }
  /** Restore the deferred geometry (narrow sessions only) then advance readiness.
   * Readiness advancement is the load-bearing invariant and MUST run even if the
   * restore or its warning delivery throws, or a live session's queued
   * persona/messages would be starved forever (C-API-39, C-API-36). Idempotent:
   * a late deadline after the hook re-runs neither the restore nor readiness. */
  async completeInitialReady(): Promise<void> {
    if (this.initialReadyDone) return;
    this.initialReadyDone = true;
    const wasNarrowBootstrap = this.awaitingInitialReady;
    this.awaitingInitialReady = false;
    try {
      if (wasNarrowBootstrap) await this.restoreRequestedSize();
    } finally {
      this.advanceInitialReady();
    }
  }
  /** Restore the deferred physical resize; a real failure warns durably. */
  private async restoreRequestedSize(): Promise<void> {
    try {
      await super.resize(this.requestedSize);
    } catch (error) {
      // A closed PTY is a benign no-op handled in the base resize; reaching here
      // means a real error, so surface it durably instead of continuing silently.
      // Isolated so a throwing warning/activity listener cannot skip readiness.
      try {
        this.recordWarnings([
          resizeRestoreFailedWarning(this.elwoodSessionId, this.requestedSize, error),
        ]);
      } catch {
        // A warning-sink/listener failure must never block readiness release.
      }
    }
  }
  /** Advance to `ready`, falling back to opening the queue directly on failure. */
  private advanceInitialReady(): void {
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
