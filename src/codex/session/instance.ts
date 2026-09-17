/**
 * In-memory Codex session object exposed to callers.
 * Implements PRD §5.7, §7A, §8, and §9.
 */

import type { ElwoodActivityEvent } from "../../core/activity/index.ts";
import { sessionWaitForActivity, sessionWaitForStatus } from "../../core/session-wait.ts";
import type { TerminalReplayBuffer } from "../../core/terminal-replay.ts";
import type { ElwoodSessionStatus, ElwoodWarningEvent } from "../../core/types.ts";
import { emitSessionWarnings } from "../../core/warnings/session.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import type { PtyProcess } from "../../pty/types.ts";
import { AgentSessionBase } from "../../runtime/session/base.ts";
import type { PersistedLoopDefinition } from "../../state/loop-store.ts";
import type { SessionRuntime } from "../../state/runtime-paths.ts";
import { type SessionRecord, updateSessionResumeId } from "../../state/store.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { restoreCodexConfig, snapshotCodexConfig } from "../config/restore.ts";
import { runCodexModelSwitch } from "../config/transaction.ts";
import { attachCodexImages } from "../images/attach.ts";
import { codexModelPicker } from "../model-picker.ts";
import type { CodexTranscriptWatcher } from "../transcript/index.ts";
import type { CodexHookBridge } from "./bridge.ts";
import { stopCodexRuntime } from "./cleanup.ts";
import type { CodexEventHandler, CodexEventMap, CodexEventName, CodexSessionApi } from "./types.ts";
import {
  clipboardRestoreFailedWarning,
  codexRestoreFailedWarning,
  codexRestoreSkippedWarning,
} from "./warnings.ts";

export class CodexSessionImpl extends AgentSessionBase implements CodexSessionApi {
  protected readonly picker = codexModelPicker;
  private readonly bridge: CodexHookBridge;
  private readonly emitter: TypedEmitter<CodexEventMap>;
  private readonly transcriptWatcher: CodexTranscriptWatcher | undefined;
  private onInitialReady: (() => void) | undefined;

  constructor(
    record: SessionRecord,
    stateDir: string,
    runtime: SessionRuntime,
    pty: PtyProcess,
    terminal: ElwoodTerminal,
    bridge: CodexHookBridge,
    emitter: TypedEmitter<CodexEventMap>,
    terminalReplay: TerminalReplayBuffer,
    transcriptWatcher: CodexTranscriptWatcher | undefined,
    loopDefinitions: readonly PersistedLoopDefinition[],
  ) {
    super(
      "codex",
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
    this.transcriptWatcher = transcriptWatcher;
  }

  on<E extends CodexEventName>(event: E, handler: CodexEventHandler<E>) {
    // REGISTER before replaying buffered `terminal:data` (mirrors Claude): a throwing replay
    // handler must still be subscribed for FUTURE data. Replay is synchronous, so nothing interleaves.
    const unsubscribe = this.emitter.on(event, handler);
    this.replayFor(event as string, handler);
    return unsubscribe;
  }
  // The Codex CLI persists picker selections into user config.toml; restore
  // the user's prior default after the switch (C-CODEX-14). The live session
  // keeps the switched model because Codex reads its config at launch.
  //
  // The whole transaction runs under a PROCESS-WIDE config lock (see
  // config/transaction.ts) so two sessions switching at once cannot interleave
  // snapshot/restore on the shared file and persist the wrong model, and the
  // restore still fires when the picker automation rejects AFTER Codex wrote
  // config.toml — otherwise a late `waitForScreen` timeout would leave the
  // user's global default changed (C-CODEX-14).
  override setModel(id: string, options?: { readonly timeoutMs?: number }): Promise<void> {
    return runCodexModelSwitch({
      snapshot: snapshotCodexConfig,
      apply: () => super.setModel(id, options),
      restore: (snapshot) => this.restoreCodexDefault(snapshot),
      onRestoreError: (error) =>
        this.emitWarnings([codexRestoreFailedWarning(this.elwoodSessionId, error)]),
    });
  }
  private restoreCodexDefault(snapshot: string | undefined): void {
    const outcome = restoreCodexConfig(snapshot);
    if (outcome === "restored" || outcome === "unchanged") return;
    this.emitWarnings([codexRestoreSkippedWarning(this.elwoodSessionId, outcome)]);
  }
  off<E extends CodexEventName>(event: E, handler: CodexEventHandler<E>): void {
    this.emitter.off(event, handler);
  }
  // One-shot initial-ready transition via the shared anti-starvation boundary: a
  // failed persist/listener releases the queue directly and warns (C-API-42). Codex
  // has no narrow-bootstrap resize to restore, so this is just the base advance.
  completeInitialReady(): void {
    this.advanceInitialReady();
  }
  waitForStatus(match: (status: ElwoodSessionStatus) => boolean, timeoutMs?: number) {
    return sessionWaitForStatus(this, match, timeoutMs);
  }
  waitForActivity(match: (event: ElwoodActivityEvent) => boolean, timeoutMs?: number) {
    return sessionWaitForActivity(this, match, timeoutMs);
  }
  // Codex has no staged chip; the composer still shows the paste's last line.
  protected stagedPaste(screen: string, prompt: string): boolean {
    const lastLine = prompt.trim().split("\n").at(-1)?.trim();
    return lastLine !== undefined && lastLine.length > 0 && screen.includes(lastLine);
  }
  // Codex ingests an interactive image only from the OS clipboard; the Ctrl+V is
  // held while a dialog is on screen so it never confirms one (C-API-46/37).
  protected attachImages = (paths: readonly string[], signal: AbortSignal): Promise<void> =>
    attachCodexImages(
      this.terminal,
      paths,
      signal,
      () => this.isInputBlocked(),
      () => this.emitWarnings([clipboardRestoreFailedWarning(this.elwoodSessionId)]),
    );
  rememberCodexSessionId(sessionId: string): void {
    if (this.record.codex.resumeId) return;
    this.persist(updateSessionResumeId(this.record, "codex", sessionId));
  }
  /** Registers the readiness trigger fired by the `SessionStart` hook — Codex's
   * authoritative "initialized and accepting input" signal (C-API-28). */
  setInitialReadyHook(fire: () => void): void {
    this.onInitialReady = fire;
  }
  /** Fires initial readiness from the `SessionStart` hook so the first queued
   * message is released only once Codex is actually accepting input, not on the
   * boot-time composer placeholder that would swallow it (C-API-28). */
  markInitialReadyFromHook(): void {
    this.onInitialReady?.();
  }
  observeTranscript(path?: string | null): void {
    if (path) this.transcriptWatcher?.observe(path);
  }
  /** One bounded per-pass scan of the committed transcript (an unblocked `Stop`, §7A.3). */
  scanTranscript(): void {
    this.transcriptWatcher?.scan();
  }
  override emitWarnings(warnings: readonly ElwoodWarningEvent[]): void {
    // No cast: each callback is the emitter's own `emit` bound to a correlated
    // event name, so a map/payload drift is a compile error here.
    emitSessionWarnings(warnings, {
      warning: (event) => this.emitter.emit("warning", event),
      activity: (event) => this.emitter.emit("activity", event),
    });
  }
  protected async stopRuntime(): Promise<void> {
    await stopCodexRuntime(this.bridge, this.transcriptWatcher, this.terminal, this.pty);
  }
}
