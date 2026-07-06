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
import type { ElwoodTerminal } from "../terminal/headless.ts";
import type { ElwoodActivityEvent } from "./activity.ts";
import type { AgentModelOption } from "./model-rows.ts";

export type TerminalSize = {
  readonly cols: number;
  readonly rows: number;
};

export type ElwoodSessionStatus =
  | "starting"
  | "running"
  | "ready"
  | "stopped"
  | "exited"
  | "killed"
  | "torn_down";

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

export interface ClaudeSession {
  readonly elwoodSessionId: string;
  readonly cwd: string;
  readonly status: ElwoodSessionStatus;
  readonly warnings: readonly ElwoodWarningEvent[];
  readonly terminal: ElwoodTerminal;

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
