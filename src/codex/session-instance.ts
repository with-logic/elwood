/**
 * In-memory Codex session object exposed to callers.
 * Implements PRD §5.7, §7A, §8, and §9.
 */

import type { TerminalReplayBuffer } from "../core/terminal-replay.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import type { PtyProcess } from "../pty/types.ts";
import { AgentSessionBase } from "../runtime/session-base.ts";
import { type SessionRecord, updateSessionResumeId } from "../state/store.ts";
import type { ElwoodTerminal } from "../terminal/headless.ts";
import { codexConfigPath, restoreCodexConfig, snapshotCodexConfig } from "./config-restore.ts";
import { codexModelPicker } from "./model-picker.ts";
import type { CodexHookBridge } from "./session-bridge.ts";
import { stopCodexRuntime } from "./session-cleanup.ts";
import type {
  CodexEventHandler,
  CodexEventMap,
  CodexEventName,
  CodexSession,
} from "./session-types.ts";
import { recordCodexWarnings } from "./session-warnings.ts";
import type { CodexTranscriptWatcher } from "./transcript.ts";

export class CodexSessionImpl extends AgentSessionBase implements CodexSession {
  protected readonly picker = codexModelPicker;
  private readonly bridge: CodexHookBridge;
  private readonly emitter: TypedEmitter<CodexEventMap>;
  private readonly transcriptWatcher: CodexTranscriptWatcher | undefined;

  constructor(
    record: SessionRecord,
    pty: PtyProcess,
    terminal: ElwoodTerminal,
    bridge: CodexHookBridge,
    emitter: TypedEmitter<CodexEventMap>,
    terminalReplay: TerminalReplayBuffer,
    transcriptWatcher?: CodexTranscriptWatcher,
  ) {
    super("codex", record, pty, terminal, emitter, terminalReplay);
    this.bridge = bridge;
    this.emitter = emitter;
    this.transcriptWatcher = transcriptWatcher;
  }

  on<E extends CodexEventName>(event: E, handler: CodexEventHandler<E>) {
    this.replayFor(event as string, handler);
    return this.emitter.on(event, handler);
  }
  // The Codex CLI persists picker selections into user config.toml; restore
  // the user's prior default after the switch (C-CODEX-14). The live session
  // keeps the switched model because Codex reads its config at launch.
  override async setModel(id: string, options?: { readonly timeoutMs?: number }): Promise<void> {
    const snapshot = snapshotCodexConfig();
    await super.setModel(id, options);
    if (restoreCodexConfig(snapshot) !== "skipped") return;
    this.recordWarnings([
      {
        elwoodSessionId: this.elwoodSessionId,
        agent: "codex",
        source: "lifecycle",
        code: "codex_default_model_persisted",
        severity: "warning",
        message:
          "Codex persisted the picker selection as the user's default model, and Elwood skipped the restore because config.toml changed in other ways during the switch.",
        raw: codexConfigPath(),
      },
    ]);
  }
  off<E extends CodexEventName>(event: E, handler: CodexEventHandler<E>): void {
    this.emitter.off(event, handler);
  }
  rememberCodexSessionId(sessionId: string): void {
    if (this.record.codex.resumeId) return;
    this.persist(updateSessionResumeId(this.record, "codex", sessionId));
  }
  observeTranscript(path?: string | null): void {
    if (path) this.transcriptWatcher?.observe(path);
  }
  flushTranscript(): void {
    this.transcriptWatcher?.flush();
  }
  recordWarnings(warnings: readonly ElwoodWarningEvent[]): void {
    recordCodexWarnings(this.record, warnings, (record) => this.persist(record), this.emitter);
  }
  protected async stopRuntime(): Promise<void> {
    await stopCodexRuntime(this.bridge, this.transcriptWatcher, this.terminal);
  }
}
