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
  InitialReadyFallbackReason,
  TerminalSize,
} from "../core/types.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import type { PtyProcess } from "../pty/types.ts";
import { AgentSessionBase } from "../runtime/session-base.ts";
import { terminalStatuses } from "../runtime/session-status.ts";
import { type SessionRecord, updateSessionResumeId, updateSessionStatus } from "../state/store.ts";
import type { ElwoodTerminal } from "../terminal/headless.ts";
import { attachClaudeImages } from "./attach-images.ts";
import { initialReadyFallbackWarning } from "./initial-ready-fallback.ts";
import { runSessionLogin } from "./login/session-login.ts";
import type { ClaudeLoginOptions } from "./login/types.ts";
import { LoginExpiredWatcher, loginExpiredWarning } from "./login-expired.ts";
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
  // Only a session requested BELOW the 100-column startup floor bootstraps wide and
  // defers its restore to readiness (C-API-36); a 100+ session resizes immediately.
  private awaitingInitialReady: boolean;
  // Whether the one-shot initial-ready transition has already run (idempotent).
  private initialReadyDone = false;
  // Edge-detects a mid-session login-expiry banner so it warns once per occurrence.
  private readonly loginExpiredWatcher = new LoginExpiredWatcher();

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
  // Claude reads a pasted absolute image path itself (C-API-45).
  protected attachImages = (paths: readonly string[], signal: AbortSignal): Promise<void> =>
    attachClaudeImages(this.terminal, paths, signal);
  // A narrow session holds the PHYSICAL resize until readiness but persists the
  // requested size now (a pre-ready exit resumes at the latest geometry, not the
  // bootstrap width). A wide session (100+ cols) never deferred; it resizes now.
  override resize(size: TerminalSize): Promise<void> {
    if (!(this.awaitingInitialReady && !terminalStatuses.has(this.status))) {
      this.requestedSize = size;
      return super.resize(size);
    }
    // Non-terminal here: record the size now (unless the pty is racing exit) and
    // defer the physical resize. `size` becomes the requested geometry ONLY if the
    // held persist succeeds; a rejected persist rejects to the caller (C-API-25/39).
    return Promise.resolve().then(() => {
      this.persistHeldSize(size);
      this.requestedSize = size;
    });
  }
  // Restore deferred geometry (narrow only) then advance readiness — which MUST run even
  // if the restore/warning throws, or queued messages starve (C-API-39/36). Idempotent.
  completeInitialReady(): Promise<void> {
    if (this.initialReadyDone) return Promise.resolve();
    this.initialReadyDone = true;
    const wasNarrowBootstrap = this.awaitingInitialReady;
    this.awaitingInitialReady = false;
    try {
      if (wasNarrowBootstrap) this.restoreRequestedSize();
    } finally {
      this.advanceInitialReady();
    }
    return Promise.resolve();
  }
  // Apply ONLY the deferred physical geometry (already persisted by `resize`), so only
  // a genuine native resize failure reports as staying at bootstrap width (C-API-39).
  private restoreRequestedSize(): void {
    try {
      this.restoreHeldSize(this.requestedSize);
    } catch (error) {
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
  private advanceInitialReady(): void {
    try {
      this.submitEvidence("initial_ready");
    } catch {
      // Classify BEFORE releasing (`markReady` drains to `running`, masking a
      // persist fault), then release unconditionally and warn.
      const reason = this.classifyInitialReadyFailure();
      this.controlQueue.markReady();
      this.warnInitialReadyFallback(reason);
    }
  }
  // Re-attempt the `ready` durable write to classify the throw: success ⇒ a lifecycle
  // LISTENER threw; throw ⇒ PERSISTENCE failing. Explicit record (disk-first persist
  // leaves `this.record` un-advanced).
  private classifyInitialReadyFailure(): InitialReadyFallbackReason {
    try {
      this.persist(updateSessionStatus(this.record, "ready"));
      return "listener";
    } catch {
      return "persist";
    }
  }
  private warnInitialReadyFallback(reason: InitialReadyFallbackReason): void {
    try {
      this.recordWarnings([initialReadyFallbackWarning(this.elwoodSessionId, reason)]);
    } catch {
      // A warning-sink/listener failure must never block readiness release.
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
  // Surface a mid-session login-expiry banner once (C-CLAUDE-18): gated on prior
  // readiness (startup handles it fatally), edge-detected + key-deduped. FULLY
  // non-throwing — runs in the frame callback's detached continuation, so a
  // write/listener failure can't become an unhandled rejection or skip
  // `terminal:data`. The watcher commits only after a durable record, so a
  // transient failure retries on a later frame.
  noteLoginExpiry(screenText: string): void {
    if (!(this.hasBeenReady && this.loginExpiredWatcher.peek(screenText))) return;
    try {
      this.recordWarnings([loginExpiredWarning(this.elwoodSessionId)]);
      this.loginExpiredWatcher.commit();
    } catch {
      // Un-committed so a later frame retries.
    }
  }
  // Drive `/login` re-auth as an exclusive, abort-aware queue transaction (C-API-43).
  login(options: ClaudeLoginOptions): Promise<void> {
    const onReady = (handler: () => void) =>
      this.emitter.on("status", (e) => e.status === "ready" && handler());
    const blocked = () => this.status === "blocked";
    const deps = { controlQueue: this.controlQueue, terminal: this.terminal, blocked, onReady };
    return this.inSession(() => runSessionLogin(deps, options));
  }
  protected async stopRuntime(): Promise<void> {
    await this.bridge.stop();
    this.terminal.dispose();
  }
}
