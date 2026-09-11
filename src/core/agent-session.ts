/**
 * Adapter-neutral session view satisfied by Claude and Codex sessions.
 * Implements PRD §5.7 shared surface and C-API-27.
 */

import type { ElwoodTerminal } from "../terminal/headless.ts";
import type { ElwoodActivityEvent } from "./activity/index.ts";
import type { SendOptions } from "./images/types.ts";
import type { LoopControls } from "./loops/loop-controls.ts";
import type { AgentModelOption } from "./models/rows.ts";
import type {
  ActivityMatch,
  ElwoodCommonEventMap,
  ElwoodCommonEventName,
  ElwoodSessionStatus,
  ElwoodStatusDecision,
  StatusMatch,
  TerminalSize,
  Unsubscribe,
} from "./types.ts";

export type { ElwoodCommonEventMap, ElwoodCommonEventName } from "./types.ts";

/**
 * Structural supertype of ClaudeSessionApi and CodexSessionApi. Code generic over
 * "any agent session" can hold either concrete session as this type and use
 * the shared events, io, commands, and lifecycle without adapter-specific
 * generics.
 */
export interface ElwoodAgentSession extends LoopControls {
  readonly elwoodSessionId: string;
  readonly cwd: string;
  readonly status: ElwoodSessionStatus;
  readonly terminal: ElwoodTerminal;

  /** Live-only log of recent status decisions, oldest first, for diagnostics. */
  statusDecisions(): readonly ElwoodStatusDecision[];
  waitForStatus(match: StatusMatch, timeoutMs?: number): Promise<ElwoodSessionStatus>;
  waitForActivity(match: ActivityMatch, timeoutMs?: number): Promise<ElwoodActivityEvent>;

  on<E extends ElwoodCommonEventName>(
    event: E,
    handler: (event: ElwoodCommonEventMap[E]) => void,
  ): Unsubscribe;
  off<E extends ElwoodCommonEventName>(
    event: E,
    handler: (event: ElwoodCommonEventMap[E]) => void,
  ): void;

  sendPrompt(prompt: string, options?: SendOptions): Promise<void>;
  sendMessage(message: string, options?: SendOptions): Promise<void>;
  sendGuidance(message: string, options?: SendOptions): Promise<void>;
  sendKeys(input: string | Uint8Array): Promise<void>;
  resize(size: TerminalSize): Promise<void>;
  interrupt(options?: { readonly timeoutMs?: number }): Promise<void>;
  compact(options?: { readonly timeoutMs?: number }): Promise<void>;
  listModels(options?: { readonly timeoutMs?: number }): Promise<readonly AgentModelOption[]>;
  setModel(id: string, options?: { readonly timeoutMs?: number }): Promise<void>;
  stop(): Promise<void>;
  kill(): Promise<void>;
  teardown(): Promise<void>;
}
