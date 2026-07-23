/**
 * Public ClaudeSession interface: the Claude-typed session surface callers use.
 * Implements PRD §5 public API.
 */

import type { ElwoodActivityEvent } from "../core/activity.ts";
import type { SendOptions } from "../core/images/types.ts";
import type { AgentModelOption } from "../core/model-rows.ts";
import type {
  ActivityMatch,
  ElwoodEventHandler,
  ElwoodEventName,
  ElwoodSessionStatus,
  ElwoodStatusDecision,
  StatusMatch,
  TerminalSize,
  Unsubscribe,
} from "../core/types.ts";
import type { ElwoodTerminal } from "../terminal/headless.ts";
import type { ClaudeLoginOptions } from "./login/types.ts";

export interface ClaudeSession {
  readonly elwoodSessionId: string;
  readonly cwd: string;
  readonly status: ElwoodSessionStatus;
  readonly terminal: ElwoodTerminal;
  statusDecisions(): readonly ElwoodStatusDecision[];
  waitForStatus(match: StatusMatch, timeoutMs?: number): Promise<ElwoodSessionStatus>;
  waitForActivity(match: ActivityMatch, timeoutMs?: number): Promise<ElwoodActivityEvent>;

  on<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>): Unsubscribe;
  off<E extends ElwoodEventName>(event: E, handler: ElwoodEventHandler<E>): void;

  sendPrompt(prompt: string, options?: SendOptions): Promise<void>;
  sendMessage(message: string, options?: SendOptions): Promise<void>;
  sendGuidance(message: string, options?: SendOptions): Promise<void>;
  sendKeys(input: string | Uint8Array): Promise<void>;
  resize(size: TerminalSize): Promise<void>;
  interrupt(options?: { readonly timeoutMs?: number }): Promise<void>;
  compact(options?: { readonly timeoutMs?: number }): Promise<void>;
  listModels(options?: { readonly timeoutMs?: number }): Promise<readonly AgentModelOption[]>;
  setModel(id: string, options?: { readonly timeoutMs?: number }): Promise<void>;
  /** Drive the interactive `/login` re-authentication flow to recover a lapsed login (C-API-43). */
  login(options: ClaudeLoginOptions): Promise<void>;
  stop(): Promise<void>;
  kill(): Promise<void>;
  teardown(): Promise<void>;
}
