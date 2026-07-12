/**
 * Adapter-neutral session view satisfied by Claude and Codex sessions.
 * Implements PRD §5.7 shared surface and C-API-27.
 */

import type { ElwoodTerminal } from "../terminal/headless.ts";
import type { ElwoodActivityEvent } from "./activity.ts";
import type { AgentModelOption } from "./model-rows.ts";
import type {
  ActivityMatch,
  ElwoodSessionStatus,
  ElwoodStatusDecision,
  ElwoodWarningEvent,
  HookErrorEvent,
  StatusMatch,
  TerminalSize,
  Unsubscribe,
} from "./types.ts";

/** Events every adapter session emits with identical payload shapes. */
export type ElwoodCommonEventMap = {
  readonly "terminal:data": { readonly elwoodSessionId: string; readonly data: string };
  readonly "terminal:exit": {
    readonly elwoodSessionId: string;
    readonly exitCode: number;
    readonly signal?: number;
  };
  readonly status: {
    readonly elwoodSessionId: string;
    readonly status: ElwoodSessionStatus;
  };
  readonly activity: ElwoodActivityEvent;
  readonly warning: ElwoodWarningEvent;
  readonly hookError: HookErrorEvent;
};

export type ElwoodCommonEventName = keyof ElwoodCommonEventMap;

/**
 * Structural supertype of ClaudeSession and CodexSession. Code generic over
 * "any agent session" can hold either concrete session as this type and use
 * the shared events, io, commands, and lifecycle without adapter-specific
 * generics.
 */
export interface ElwoodAgentSession {
  readonly elwoodSessionId: string;
  readonly cwd: string;
  readonly status: ElwoodSessionStatus;
  readonly warnings: readonly ElwoodWarningEvent[];
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

  sendPrompt(prompt: string): Promise<void>;
  sendMessage(message: string): Promise<void>;
  sendGuidance(message: string): Promise<void>;
  sendKeys(input: string | Uint8Array): Promise<void>;
  resize(size: TerminalSize): Promise<void>;
  compact(options?: { readonly timeoutMs?: number }): Promise<void>;
  listModels(options?: { readonly timeoutMs?: number }): Promise<readonly AgentModelOption[]>;
  setModel(id: string, options?: { readonly timeoutMs?: number }): Promise<void>;
  stop(): Promise<void>;
  kill(): Promise<void>;
  teardown(): Promise<void>;
}
