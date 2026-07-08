/**
 * Public ClaudeSession interface: the Claude-typed session surface callers use.
 * Implements PRD §5 public API.
 */

import type { ElwoodActivityEvent } from "../core/activity.ts";
import type { AgentModelOption } from "../core/model-rows.ts";
import type {
  ActivityMatch,
  ElwoodEventHandler,
  ElwoodEventName,
  ElwoodSessionStatus,
  ElwoodStatusDecision,
  ElwoodWarningEvent,
  StatusMatch,
  TerminalSize,
  Unsubscribe,
} from "../core/types.ts";
import type { ElwoodTerminal } from "../terminal/headless.ts";

export interface ClaudeSession {
  readonly elwoodSessionId: string;
  readonly cwd: string;
  readonly status: ElwoodSessionStatus;
  readonly warnings: readonly ElwoodWarningEvent[];
  readonly terminal: ElwoodTerminal;
  statusDecisions(): readonly ElwoodStatusDecision[];
  waitForStatus(match: StatusMatch, timeoutMs?: number): Promise<ElwoodSessionStatus>;
  waitForActivity(match: ActivityMatch, timeoutMs?: number): Promise<ElwoodActivityEvent>;

  on<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>): Unsubscribe;
  off<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>): void;

  sendPrompt(prompt: string): Promise<void>;
  sendMessage(message: string): Promise<void>;
  sendKeys(input: string | Uint8Array): Promise<void>;
  resize(size: TerminalSize): Promise<void>;
  compact(options?: { readonly timeoutMs?: number }): Promise<void>;
  listModels(options?: { readonly timeoutMs?: number }): Promise<readonly AgentModelOption[]>;
  setModel(id: string, options?: { readonly timeoutMs?: number }): Promise<void>;
  stop(): Promise<void>;
  kill(): Promise<void>;
  teardown(): Promise<void>;
}
