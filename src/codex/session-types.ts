/**
 * Public Codex session API types.
 * Implements PRD §5.5, §5.6, and §5.7.
 */

import type { ElwoodActivityEvent } from "../core/activity.ts";
import type { AgentModelOption } from "../core/model-rows.ts";
import type {
  ElwoodSessionStatus,
  ElwoodWarningEvent,
  HookErrorEvent,
  TerminalSize,
  Unsubscribe,
} from "../core/types.ts";
import type { ElwoodTerminal } from "../terminal/headless.ts";
import type {
  CodexHookEvent,
  CodexHookEventFor,
  CodexHookEventName,
  CodexHookHandlers,
  CodexHookResultFor,
} from "./hooks.ts";
import type { CodexTranscriptEvent } from "./transcript.ts";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";

export type StartCodexOptions = {
  readonly cwd: string;
  readonly stateDir?: string;
  readonly name?: string;
  readonly initialSize?: TerminalSize;
  readonly hooks?: CodexHookHandlers;
  readonly persona?: string;
  readonly model?: string;
  readonly profile?: string;
  readonly sandbox?: CodexSandboxMode;
  readonly approvalPolicy?: CodexApprovalPolicy;
  readonly configOverrides?: readonly string[];
  readonly autoupdate?: boolean;
  readonly autotrust?: boolean;
  readonly hookTimeoutMs?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly strictVersionCheck?: boolean;
};

export type ResumeCodexOptions = {
  readonly elwoodSessionId: string;
  readonly cwd?: string;
  readonly stateDir?: string;
  readonly hooks?: CodexHookHandlers;
  readonly initialSize?: TerminalSize;
  readonly autoupdate?: boolean;
  readonly autotrust?: boolean;
  readonly hookTimeoutMs?: number;
  readonly strictVersionCheck?: boolean;
};

export type CodexEventMap = {
  readonly "terminal:data": { readonly elwoodSessionId: string; readonly data: string };
  readonly "terminal:exit": {
    readonly elwoodSessionId: string;
    readonly exitCode: number;
    readonly signal?: number;
  };
  readonly status: { readonly elwoodSessionId: string; readonly status: ElwoodSessionStatus };
  readonly activity: ElwoodActivityEvent;
  readonly warning: ElwoodWarningEvent;
  readonly hook: CodexHookEvent;
  readonly "codex:transcript": CodexTranscriptEvent;
  readonly hookError: HookErrorEvent;
} & {
  readonly [K in `hook:${CodexHookEventName}`]: K extends `hook:${infer N}`
    ? N extends CodexHookEventName
      ? CodexHookEventFor<N>
      : never
    : never;
};

export type CodexEventName = keyof CodexEventMap;

export type CodexEventHandler<E extends CodexEventName> = (
  event: CodexEventMap[E],
) => E extends `hook:${infer K}`
  ? K extends CodexHookEventName
    ? CodexHookResultFor<K> | Promise<CodexHookResultFor<K>>
    : undefined
  : void;

export interface CodexSession {
  readonly elwoodSessionId: string;
  readonly cwd: string;
  readonly status: ElwoodSessionStatus;
  readonly warnings: readonly ElwoodWarningEvent[];
  readonly terminal: ElwoodTerminal;

  on<E extends CodexEventName>(event: E, handler: CodexEventHandler<E>): Unsubscribe;
  off<E extends CodexEventName>(event: E, handler: CodexEventHandler<E>): void;

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
