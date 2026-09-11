/**
 * Public library types shared across Elwood adapters.
 * Implements PRD §5 and §9.
 */

import type {
  ClaudeHookEvent,
  ClaudeHookEventFor,
  ClaudeHookEventName,
  ClaudeHookHandlers,
  ClaudeHookResult,
  ClaudeHookResultFor,
} from "../claude/hooks/index.ts";
import type { CodexHookEventName } from "../codex/hooks/names.ts";
import type { ElwoodActivityEvent } from "./activity/index.ts";
import type { ElwoodLoopEvent } from "./loops/types.ts";
import type { ClaudeReasoningEffort } from "./reasoning-effort.ts";
import type { ElwoodSessionStatus } from "./status-categories.ts";
import type { ElwoodWarningEvent } from "./warnings/index.ts";

export type { ElwoodSessionStatus, ElwoodWarningEvent };

export type TerminalSize = {
  readonly cols: number;
  readonly rows: number;
};

/** The kinds of evidence that can drive a session status transition. */
export type ElwoodStatusEvidence =
  | "startup_usable"
  | "initial_ready"
  | "hook_turn_ended"
  | "rendered_turn_started"
  | "rendered_turn_ended"
  | "caller_submitted"
  | "blocking_prompt_shown"
  | "blocking_prompt_cleared"
  | "terminal_exited"
  | "stop_completed"
  | "kill_completed"
  | "teardown_completed";

/** One live-only status-decision log entry; `to` is undefined when ignored. */
export type ElwoodStatusDecision = {
  readonly evidence: ElwoodStatusEvidence;
  readonly from: ElwoodSessionStatus;
  readonly to: ElwoodSessionStatus | undefined;
  readonly reason: string;
};

export type StatusMatch = (status: ElwoodSessionStatus) => boolean;
export type ActivityMatch = (event: ElwoodActivityEvent) => boolean;

export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";

export type ClaudeToolRule = string;
export type ClaudeSettingsOverrides = Readonly<Record<string, unknown>>;

export type StartClaudeOptions = {
  readonly cwd: string;
  readonly stateDir?: string;
  readonly name?: string;
  readonly initialSize?: TerminalSize;
  readonly hooks?: ClaudeHookHandlers;
  readonly persona?: string;
  readonly model?: string;
  readonly reasoningEffort?: ClaudeReasoningEffort;
  readonly permissionMode?: ClaudePermissionMode;
  readonly allowedTools?: readonly ClaudeToolRule[];
  readonly disallowedTools?: readonly ClaudeToolRule[];
  readonly tools?: readonly ClaudeToolRule[];
  readonly settingsOverrides?: ClaudeSettingsOverrides;
  readonly autoupdate?: boolean;
  readonly autotrust?: boolean;
  readonly hookTimeoutMs?: number;
  readonly strictVersionCheck?: boolean;
};

export type ResumeClaudeOptions = {
  readonly elwoodSessionId: string;
  readonly cwd?: string;
  readonly stateDir?: string;
  readonly hooks?: ClaudeHookHandlers;
  readonly initialSize?: TerminalSize;
  readonly reasoningEffort?: ClaudeReasoningEffort;
  readonly permissionMode?: ClaudePermissionMode;
  readonly allowedTools?: readonly ClaudeToolRule[];
  readonly disallowedTools?: readonly ClaudeToolRule[];
  readonly tools?: readonly ClaudeToolRule[];
  readonly autoupdate?: boolean;
  readonly autotrust?: boolean;
  readonly hookTimeoutMs?: number;
  readonly strictVersionCheck?: boolean;
};

export type HookErrorEvent = {
  readonly elwoodSessionId: string;
  readonly hookEventName: ClaudeHookEventName | CodexHookEventName | "Unknown";
  readonly category:
    | "timeout"
    | "handler_error"
    | "invalid_input"
    | "invalid_response"
    | "bridge_error";
  readonly message: string;
  readonly timeoutMs?: number;
};

/** Events every adapter session emits with identical payload shapes (§5.7). */
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
  readonly loop: ElwoodLoopEvent;
  readonly hookError: HookErrorEvent;
};

export type ElwoodCommonEventName = keyof ElwoodCommonEventMap;

/** The Claude session's events: the common map plus its typed `hook` / `hook:<Name>` events. */
export type ClaudeEventMap = ElwoodCommonEventMap & {
  readonly hook: ClaudeHookEvent;
} & {
  readonly [K in `hook:${ClaudeHookEventName}`]: K extends `hook:${infer N}`
    ? N extends ClaudeHookEventName
      ? ClaudeHookEventFor<N>
      : never
    : never;
};

export type ClaudeEventName = keyof ClaudeEventMap;

export type ClaudeEventHandler<E extends ClaudeEventName> = (
  event: ClaudeEventMap[E],
) => E extends `hook:${infer K}`
  ? K extends ClaudeHookEventName
    ? ClaudeHookResultFor<K> | Promise<ClaudeHookResultFor<K>>
    : ClaudeHookResult | Promise<ClaudeHookResult>
  : void;

/** @deprecated Claude-specific despite the generic name; use `ClaudeEventMap`. */
export type ElwoodEventMap = ClaudeEventMap;
/** @deprecated Claude-specific despite the generic name; use `ClaudeEventName`. */
export type ElwoodEventName = ClaudeEventName;
/** @deprecated Claude-specific despite the generic name; use `ClaudeEventHandler`. */
export type ElwoodEventHandler<E extends ClaudeEventName> = ClaudeEventHandler<E>;

export type Unsubscribe = () => void;
