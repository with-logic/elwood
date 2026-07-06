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
