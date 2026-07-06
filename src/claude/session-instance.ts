/**
 * In-memory Claude session object exposed to callers.
 * Implements PRD §4.1, §5, §6, §7, and §8.
 */

import type { TerminalReplayBuffer } from "../core/terminal-replay.ts";
import type { ClaudeSession, ElwoodEventHandler, ElwoodEventName } from "../core/types.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import type { PtyProcess } from "../pty/types.ts";
import { AgentSessionBase } from "../runtime/session-base.ts";
import { type SessionRecord, updateSessionResumeId } from "../state/store.ts";
import type { ElwoodTerminal } from "../terminal/headless.ts";
import { claudeModelPicker } from "./model-picker.ts";

export type HookBridge = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

export class ClaudeSessionImpl extends AgentSessionBase implements ClaudeSession {
  protected readonly picker = claudeModelPicker;
  private readonly bridge: HookBridge;
  private readonly emitter: TypedEmitter;

  constructor(
    record: SessionRecord,
    pty: PtyProcess,
    terminal: ElwoodTerminal,
    bridge: HookBridge,
    emitter: TypedEmitter,
    terminalReplay: TerminalReplayBuffer,
  ) {
    super("claude", record, pty, terminal, emitter, terminalReplay);
    this.bridge = bridge;
    this.emitter = emitter;
  }

  on<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>) {
    this.replayFor(event, handler);
    return this.emitter.on(event, handler);
  }
  off<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>): void {
    this.emitter.off(event, handler);
  }
  rememberClaudeSessionId(sessionId: string): void {
    if (this.record.claude.resumeId) return;
    this.persist(updateSessionResumeId(this.record, "claude", sessionId));
  }
  protected async stopRuntime(): Promise<void> {
    await this.bridge.stop();
    this.terminal.dispose();
  }
}
