/** In-memory Claude session object exposed to callers. Implements PRD §4.1, §5, §6, §7, §8. */
import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import { sessionWaitForActivity, sessionWaitForStatus } from "../../core/session-wait.ts";
import { terminalStatuses } from "../../core/status-categories.ts";
import type { TerminalReplayBuffer } from "../../core/terminal-replay.ts";
import type {
  ClaudeEventMap,
  ElwoodEventHandler,
  ElwoodEventName,
  ElwoodSessionStatus,
  ElwoodWarningEvent,
  TerminalSize,
} from "../../core/types.ts";
import { emitSessionWarnings } from "../../core/warnings/session.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import type { PtyProcess } from "../../pty/types.ts";
import { AgentSessionBase } from "../../runtime/session/base.ts";
import { runCleanupSteps } from "../../runtime/shutdown/teardown.ts";
import type { PersistedLoopDefinition } from "../../state/loop-store.ts";
import type { SessionRuntime } from "../../state/runtime-paths.ts";
import { type SessionRecord, updateSessionResumeId } from "../../state/store.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { attachClaudeImages } from "../attach-images.ts";
import { runSessionLogin } from "../login/session-login.ts";
import type { ClaudeLoginOptions } from "../login/types.ts";
import { LoginExpiredWatcher, loginExpiredWarning } from "../login-expired.ts";
import { claudeModelPicker } from "../model-picker.ts";
import { resizeRestoreFailedWarning } from "../resize-restore.ts";
import { CLAUDE_STARTUP_MIN_COLS } from "../startup-size.ts";
import type { ClaudeSessionApi } from "./interface.ts";

export type HookBridge = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

export class ClaudeSessionImpl extends AgentSessionBase implements ClaudeSessionApi {
  protected readonly picker = claudeModelPicker;
  private readonly bridge: HookBridge;
  private readonly emitter: TypedEmitter<ClaudeEventMap>;
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
    stateDir: string,
    runtime: SessionRuntime,
    pty: PtyProcess,
    terminal: ElwoodTerminal,
    bridge: HookBridge,
    emitter: TypedEmitter<ClaudeEventMap>,
    terminalReplay: TerminalReplayBuffer,
    requestedSize: TerminalSize,
    loopDefinitions: readonly PersistedLoopDefinition[],
  ) {
    super(
      "claude",
      record,
      stateDir,
      runtime,
      pty,
      terminal,
      emitter,
      terminalReplay,
      loopDefinitions,
    );
    this.bridge = bridge;
    this.emitter = emitter;
    this.requestedSize = requestedSize;
    this.awaitingInitialReady = requestedSize.cols < CLAUDE_STARTUP_MIN_COLS;
  }

  on<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>) {
    // REGISTER before replaying buffered `terminal:data`: a throwing replay handler must still be
    // subscribed for FUTURE data (otherwise startup telemetry silently disappears). Replay is of
    // already-buffered past data and runs synchronously, so no live event interleaves.
    const unsubscribe = this.emitter.on(event, handler);
    this.replayFor(event, handler);
    return unsubscribe;
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
  // Claude reads a pasted absolute path; the paste is held while a dialog shows (C-API-45/37).
  protected attachImages = (paths: readonly string[], signal: AbortSignal): Promise<void> =>
    attachClaudeImages(this.terminal, paths, signal, () => this.isInputBlocked());
  // A narrow session holds the PHYSICAL resize until readiness; it just records the
  // requested geometry now and restores it at the initial-ready transition. A wide
  // session (100+ cols) never deferred; it resizes now.
  override resize(size: TerminalSize): Promise<void> {
    if (!(this.awaitingInitialReady && !terminalStatuses.has(this.status))) {
      this.requestedSize = size;
      return super.resize(size);
    }
    // Non-terminal here: capture the requested geometry to restore at readiness
    // without disturbing the live bootstrap width (C-API-25/39).
    this.requestedSize = size;
    return Promise.resolve();
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
  // Apply the deferred physical geometry, so only a genuine native resize failure
  // reports as staying at bootstrap width (C-API-39).
  private restoreRequestedSize(): void {
    try {
      this.restoreHeldSize(this.requestedSize);
    } catch (error) {
      // Isolated so a throwing warning/activity listener cannot skip readiness.
      try {
        this.emitWarnings([
          resizeRestoreFailedWarning(this.elwoodSessionId, this.requestedSize, error),
        ]);
      } catch {
        // A warning-sink/listener failure must never block readiness release.
      }
    }
  }
  rememberClaudeSessionId(sessionId: string): void {
    if (this.record.claude.resumeId) return;
    this.persist(updateSessionResumeId(this.record, "claude", sessionId));
  }
  override emitWarnings(warnings: readonly ElwoodWarningEvent[]): void {
    emitSessionWarnings(warnings, {
      warning: (event) => this.emitter.emit("warning", event),
      activity: (event) => this.emitter.emit("activity", event),
    });
  }
  // Surface a mid-session login-expiry banner once (C-CLAUDE-18): gated on prior
  // readiness (startup handles it fatally), edge-detected. FULLY non-throwing — runs
  // in the frame callback's detached continuation, so a listener failure can't become
  // an unhandled rejection or skip `terminal:data`. COMMIT the edge BEFORE the live
  // fan-out: warnings are live-only (fire exactly once), and emitWarnings delivers to
  // every listener before rethrowing a listener error — committing after would treat
  // a throwing listener as non-delivery and re-fire the SAME incident to the listeners
  // that already received it (a duplicate). A throwing listener is contained here.
  noteLoginExpiry(screenText: string): void {
    if (!(this.everReady && this.loginExpiredWatcher.peek(screenText))) return;
    this.loginExpiredWatcher.commit();
    try {
      this.emitWarnings([loginExpiredWarning(this.elwoodSessionId)]);
    } catch {
      // Live-only: a throwing listener is contained and the warning is dropped, not
      // re-fired — the edge is already committed so a persistent banner warns once.
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
  protected stopRuntime(): Promise<void> {
    // Dispose the terminal even if the bridge stop rejects — no first-failure leak (§9.4).
    return runCleanupSteps([() => this.bridge.stop(), () => this.terminal.dispose()]);
  }
}
