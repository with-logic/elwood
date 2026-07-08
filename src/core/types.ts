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
} from "../claude/hooks.ts";
import type { CodexHookEventName } from "../codex/hook-names.ts";
import type { ElwoodActivityEvent } from "./activity.ts";

export type TerminalSize = {
  readonly cols: number;
  readonly rows: number;
};

import type { ElwoodSessionStatus } from "./status-categories.ts";

export type { ElwoodSessionStatus };

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
  readonly permissionMode?: ClaudePermissionMode;
  readonly allowedTools?: readonly ClaudeToolRule[];
  readonly disallowedTools?: readonly ClaudeToolRule[];
  readonly tools?: readonly ClaudeToolRule[];
  readonly settingsOverrides?: ClaudeSettingsOverrides;
  readonly autoupdate?: boolean;
  readonly autotrust?: boolean;
  readonly hookTimeoutMs?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly strictVersionCheck?: boolean;
};

export type ResumeClaudeOptions = {
  readonly elwoodSessionId: string;
  readonly cwd?: string;
  readonly stateDir?: string;
  readonly hooks?: ClaudeHookHandlers;
  readonly initialSize?: TerminalSize;
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

export type ElwoodWarningEvent =
  | {
      readonly elwoodSessionId: string;
      readonly agent: "claude" | "codex";
      readonly source: "lifecycle";
      readonly code: "version_unparseable";
      readonly severity: "warning";
      readonly message: string;
      readonly raw: string;
    }
  | {
      readonly elwoodSessionId: string;
      readonly agent: "codex";
      readonly source: "terminal";
      readonly code: "mcp_server_not_logged_in";
      readonly severity: "warning";
      readonly message: string;
      readonly mcpServerName: string;
      readonly recoveryCommand: string;
      readonly raw: string;
    }
  | {
      readonly elwoodSessionId: string;
      readonly agent: "codex";
      readonly source: "terminal";
      readonly code: "mcp_startup_incomplete";
      readonly severity: "warning";
      readonly message: string;
      readonly failedServers: readonly string[];
      readonly recoveryCommands: readonly string[];
      readonly raw: string;
    }
  | {
      readonly elwoodSessionId: string;
      readonly agent: "codex";
      readonly source: "lifecycle";
      readonly code: "codex_default_model_persisted";
      readonly severity: "warning";
      readonly message: string;
      readonly raw: string;
    };

export type ElwoodEventMap = {
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
  readonly hook: ClaudeHookEvent;
  readonly hookError: HookErrorEvent;
} & {
  readonly [K in `hook:${ClaudeHookEventName}`]: K extends `hook:${infer N}`
    ? N extends ClaudeHookEventName
      ? ClaudeHookEventFor<N>
      : never
    : never;
};

export type ElwoodEventName = keyof ElwoodEventMap;

export type ElwoodEventHandler<E extends ElwoodEventName> = (
  event: ElwoodEventMap[E],
) => E extends `hook:${infer K}`
  ? K extends ClaudeHookEventName
    ? ClaudeHookResultFor<K> | Promise<ClaudeHookResultFor<K>>
    : ClaudeHookResult | Promise<ClaudeHookResult>
  : void;

export type Unsubscribe = () => void;
