/**
 * Shared adapter selection helpers for local Elwood developer apps.
 * Implements PRD §11.
 */

import {
  type ClaudeHookEvent,
  type ClaudeHookHandlers,
  type ClaudeHookResult,
  type ClaudeSessionApi,
  type CodexHookEvent,
  type CodexHookHandlers,
  type CodexHookResult,
  type CodexSessionApi,
  claudeHookEventNames,
  codexHookEventNames,
  type ElwoodActivityEvent,
  type ElwoodWarningEvent,
  type ResumeClaudeOptions,
  type ResumeCodexOptions,
  resumeClaude,
  resumeCodex,
  type StartClaudeOptions,
  type StartCodexOptions,
  startClaude,
  startCodex,
  type TerminalSize,
  type Unsubscribe,
} from "../src/index.ts";

export type AgentKind = "claude" | "codex";
export type AgentHooks = ClaudeHookHandlers | CodexHookHandlers;
export type AgentHookEvent = ClaudeHookEvent | CodexHookEvent;
export type AgentHookResult = ClaudeHookResult | CodexHookResult;

export type CommonEventMap = {
  readonly "terminal:data": { readonly elwoodSessionId: string; readonly data: string };
  readonly "terminal:exit": {
    readonly elwoodSessionId: string;
    readonly exitCode: number;
    readonly signal?: number;
  };
  readonly status: { readonly elwoodSessionId: string; readonly status: string };
  readonly activity: ElwoodActivityEvent;
  readonly warning: ElwoodWarningEvent;
  readonly hook: AgentHookEvent;
  readonly hookError: {
    readonly elwoodSessionId: string;
    readonly hookEventName: string;
    readonly category: string;
    readonly message?: string;
  };
};

export type CommonEventName = keyof CommonEventMap;
export type CommonEventHandler<E extends CommonEventName> = (event: CommonEventMap[E]) => void;
export type SharedSession = Pick<
  ClaudeSessionApi | CodexSessionApi,
  | "elwoodSessionId"
  | "cwd"
  | "status"
  | "terminal"
  | "statusDecisions"
  | "sendPrompt"
  | "sendMessage"
  | "sendGuidance"
  | "sendKeys"
  | "resize"
  | "stop"
  | "kill"
  | "teardown"
> & {
  readonly on: <E extends CommonEventName>(event: E, handler: CommonEventHandler<E>) => Unsubscribe;
};

export type AgentRuntime = {
  readonly startClaude: (options: StartClaudeOptions) => Promise<SharedSession>;
  readonly resumeClaude: (options: ResumeClaudeOptions) => Promise<SharedSession>;
  readonly startCodex: (options: StartCodexOptions) => Promise<SharedSession>;
  readonly resumeCodex: (options: ResumeCodexOptions) => Promise<SharedSession>;
};

export type AgentLaunchOptions = {
  readonly agent: AgentKind;
  readonly cwd: string;
  readonly stateDir?: string;
  /**
   * The Elwood session id to resume, if any. Named `elwoodSessionId` (not
   * `resumeId`) because it is the public Elwood id, distinct from an adapter's
   * internal conversation `resumeId`.
   */
  readonly elwoodSessionId?: string;
  readonly size: TerminalSize;
  readonly hooks: AgentHooks;
};

export const defaultAgentRuntime: AgentRuntime = {
  startClaude: startClaude as AgentRuntime["startClaude"],
  resumeClaude: resumeClaude as AgentRuntime["resumeClaude"],
  startCodex: startCodex as AgentRuntime["startCodex"],
  resumeCodex: resumeCodex as AgentRuntime["resumeCodex"],
};

export async function startAgentSession(
  options: AgentLaunchOptions,
  runtime: AgentRuntime = defaultAgentRuntime,
): Promise<SharedSession> {
  if (options.agent === "codex") return await startCodexSession(options, runtime);
  return await startClaudeSession(options, runtime);
}

export function parseAgentKind(value: string | undefined): AgentKind {
  return value === "codex" ? "codex" : "claude";
}

export function createLiveHookHandlers(
  agent: "claude",
  log: { write(chunk: string): unknown },
): ClaudeHookHandlers;
export function createLiveHookHandlers(
  agent: "codex",
  log: { write(chunk: string): unknown },
): CodexHookHandlers;
export function createLiveHookHandlers(
  agent: AgentKind,
  log: { write(chunk: string): unknown },
): AgentHooks;
export function createLiveHookHandlers(
  agent: AgentKind,
  log: { write(chunk: string): unknown },
): AgentHooks {
  return agent === "codex" ? codexHandlers(log) : claudeHandlers(log);
}

export function summarizeHookResult(result: AgentHookResult): string {
  if (result === undefined) return "no decision";
  if ("permissionDecision" in result) return result.permissionDecision;
  if ("behavior" in result) return result.behavior;
  if ("decision" in result) return result.decision;
  if ("additionalContext" in result) return "context";
  if ("action" in result) return result.action;
  if ("retry" in result) return "retry";
  if ("worktreePath" in result) return "worktree";
  return "no decision";
}

function claudeHandlers(log: { write(chunk: string): unknown }): ClaudeHookHandlers {
  const handler = (event: ClaudeHookEvent): ClaudeHookResult => {
    log.write(formatEventLog("hook", event.hook_event_name, "no decision"));
    return undefined;
  };
  const handlers: Partial<Record<(typeof claudeHookEventNames)[number], typeof handler>> = {};
  for (const name of claudeHookEventNames) handlers[name] = handler;
  return handlers as ClaudeHookHandlers;
}

function codexHandlers(log: { write(chunk: string): unknown }): CodexHookHandlers {
  const handler = (event: CodexHookEvent): CodexHookResult => {
    log.write(formatEventLog("hook", event.hook_event_name, "no decision"));
    return undefined;
  };
  const handlers: Partial<Record<(typeof codexHookEventNames)[number], typeof handler>> = {};
  for (const name of codexHookEventNames) handlers[name] = handler;
  return handlers as CodexHookHandlers;
}

function startClaudeSession(options: AgentLaunchOptions, runtime: AgentRuntime) {
  const base = commonLaunchOptions(options);
  const hooks = options.hooks as ClaudeHookHandlers;
  return options.elwoodSessionId === undefined
    ? runtime.startClaude({ ...base, hooks })
    : runtime.resumeClaude({ ...base, hooks, elwoodSessionId: options.elwoodSessionId });
}

function startCodexSession(options: AgentLaunchOptions, runtime: AgentRuntime) {
  const base = commonLaunchOptions(options);
  const hooks = options.hooks as CodexHookHandlers;
  return options.elwoodSessionId === undefined
    ? runtime.startCodex({ ...base, hooks })
    : runtime.resumeCodex({ ...base, hooks, elwoodSessionId: options.elwoodSessionId });
}

function commonLaunchOptions(options: AgentLaunchOptions) {
  return {
    cwd: options.cwd,
    initialSize: options.size,
    ...(options.stateDir === undefined ? {} : { stateDir: options.stateDir }),
  };
}

function formatEventLog(kind: string, name: string, detail: string): string {
  return `[${kind}] ${name} ${detail}\n`;
}
