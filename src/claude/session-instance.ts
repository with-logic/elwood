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
import { type SessionRecord, updateSessionResumeId } from "../state/store.ts";
import type { ElwoodTerminal } from "../terminal/headless.ts";
import { initialReadyFallbackWarning } from "./initial-ready-fallback.ts";
import { driveLogin } from "./login/driver.ts";
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
  // Only a session requested BELOW the 100-column startup floor bootstraps wide
  // and defers its restore to readiness (C-API-36). A session requested at 100+
  // columns already starts at its exact size, so its pre-ready resizes apply
  // immediately like any other resize — nothing to hold or restore.
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
  /** A narrow session holds the PHYSICAL resize until readiness but persists the
   * requested size now, so a pre-ready exit resumes at the latest geometry, not the
   * bootstrap width. A wide session (100+ cols) never deferred; it resizes now. */
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
   * Readiness advancement MUST run even if the restore/its warning throws, or a
   * live session's queued messages starve forever (C-API-39, C-API-36). Idempotent.
   * Keeps a Promise return so hook and deadline call sites can `void`/`await` it. */
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
  // Apply ONLY the deferred physical geometry (already durably persisted by
  // `resize`), so only a genuine native PTY resize failure — not a redundant
  // persist — reports as staying at bootstrap width (C-API-39). A closed PTY is a
  // silent no-op inside `restoreHeldSize`; a real failure warns durably.
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
  /** Advance to `ready`, falling back to opening the queue directly on failure. */
  private advanceInitialReady(): void {
    try {
      this.submitEvidence("initial_ready");
    } catch {
      // Classify BEFORE releasing: `markReady` drains the first message to
      // `running`, masking a persist fault. Then release unconditionally (input
      // must not starve) and surface the fallback warning.
      const reason = this.classifyInitialReadyFailure();
      this.controlQueue.markReady();
      this.warnInitialReadyFallback(reason);
    }
  }
  // Classify the initial-ready throw by re-persisting the (still `ready`) record:
  // success ⇒ a lifecycle-event LISTENER threw; a throw ⇒ PERSISTENCE is failing.
  private classifyInitialReadyFailure(): InitialReadyFallbackReason {
    try {
      this.persist(this.record);
      return "listener";
    } catch {
      return "persist";
    }
  }
  /** Deliver the fallback diagnostic; isolated so a rogue sink can't re-starve. */
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
  // Surface a mid-session login-expiry banner once (C-CLAUDE-18). Gated on prior
  // readiness — the startup form of the banner is handled fatally upstream — and
  // edge-detected + key-deduped so a persistent banner warns at most once. Alive.
  noteLoginExpiry(screenText: string): void {
    if (this.hasBeenReady && this.loginExpiredWatcher.observe(screenText)) {
      this.recordWarnings([loginExpiredWarning(this.elwoodSessionId)]);
    }
  }
  /** Drive the interactive `/login` re-authentication flow (C-API-43). */
  login(options: ClaudeLoginOptions): Promise<void> {
    return this.inSession(() =>
      driveLogin(
        { terminal: this.terminal, submit: (c) => this.controlQueue.send(c, "login") },
        options,
      ),
    );
  }
  protected async stopRuntime(): Promise<void> {
    await this.bridge.stop();
    this.terminal.dispose();
  }
}
