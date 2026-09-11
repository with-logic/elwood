/**
 * Unified activity events shared across agent adapters.
 * Implements PRD §5.4.
 */

import type { ClaudeHookEvent } from "../../claude/hooks/index.ts";
import type { CodexHookEvent } from "../../codex/hooks/index.ts";
import { hookResultLabel } from "../hook-result.ts";
import type { ElwoodSessionStatus, ElwoodWarningEvent, HookErrorEvent } from "../types.ts";
import * as meta from "./meta.ts";

export type ElwoodAgentKind = "claude" | "codex";
export type ElwoodActivitySource = "hook" | "transcript" | "terminal" | "lifecycle";
export type ElwoodActivityKind =
  | "status"
  | "terminal_exit"
  | "user_message"
  | "assistant_message"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "web_search"
  | "other"
  | "notification"
  | "warning"
  | "startup_prompt"
  | "attention"
  | "hook"
  | "hook_result"
  | "hook_error";

export type ElwoodActivityEvent = {
  readonly elwoodSessionId: string;
  readonly agent: ElwoodAgentKind;
  readonly source: ElwoodActivitySource;
  readonly kind: ElwoodActivityKind;
  readonly label: string;
  readonly text?: string;
  readonly hookEventName?: string;
  readonly turnId?: string;
  readonly toolName?: string;
  readonly toolUseId?: string;
  readonly toolInput?: string;
  readonly toolOutput?: string;
  readonly status?: ElwoodSessionStatus;
  readonly exitCode?: number;
  readonly failedOpen?: boolean;
  readonly transcriptPath?: string;
  readonly raw?: unknown;
};

export {
  activityFromStatus,
  activityFromTerminalExit,
  reapFailureWarning,
} from "./lifecycle.ts";

/** Hook events both adapters map identically; returns undefined for the rest. */
function sharedHookActivity(
  base: Omit<ElwoodActivityEvent, "kind" | "label" | "text">,
  event: ClaudeHookEvent | CodexHookEvent,
): ElwoodActivityEvent | undefined {
  if (event.hook_event_name === "UserPromptSubmit") {
    return withText(base, "user_message", "user", event.prompt);
  }
  if (event.hook_event_name === "Notification") {
    return withText(base, "notification", event.notification_type, event.message);
  }
  return undefined;
}

/**
 * Claude hook → activity. Agent/event correlation stops a Claude event routing
 * through the Codex path. Claude tool/assistant activity is transcript-sourced
 * (C-CLAUDE-15), so those hooks stay plain `hook` here (no transcript duplicate).
 */
export function activityFromClaudeHook(
  elwoodSessionId: string,
  event: ClaudeHookEvent,
): ElwoodActivityEvent {
  const base = meta.hookActivityBase("claude", elwoodSessionId, event);
  const shared = sharedHookActivity(base, event);
  return shared ?? { ...base, kind: "hook", label: event.hook_event_name };
}

/**
 * Codex hook → activity. Codex's `assistant_message`, `tool_call`, and
 * `tool_result` are sourced from the committed `codex:transcript` (C-CODEX-16),
 * so the `Stop`/`PreToolUse`/`PostToolUse` hooks MUST NOT re-project them — that
 * surfaced every reply and every tool step twice (once from the hook, once from
 * the transcript). Those hooks stay plain `hook` turn-boundary signals here, and
 * `Stop`'s `last_assistant_message` (which can be un-submitted ghost text) never
 * becomes an `assistant_message`, exactly as for Claude (C-CLAUDE-15).
 */
export function activityFromCodexHook(
  elwoodSessionId: string,
  event: CodexHookEvent,
): ElwoodActivityEvent {
  const base = meta.hookActivityBase("codex", elwoodSessionId, event);
  const shared = sharedHookActivity(base, event);
  return shared ?? { ...base, kind: "hook", label: event.hook_event_name };
}

export function activityFromHookError(
  agent: ElwoodAgentKind,
  event: HookErrorEvent,
): ElwoodActivityEvent {
  return {
    elwoodSessionId: event.elwoodSessionId,
    agent,
    source: "hook",
    kind: "hook_error",
    label: `${event.hookEventName}:${event.category}`,
    text: event.message,
    hookEventName: event.hookEventName,
    raw: event,
  };
}

export function activityFromHookResult(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  hookEventName: string,
  result: unknown,
  failedOpen: boolean,
): ElwoodActivityEvent {
  return {
    elwoodSessionId,
    agent,
    source: "hook",
    kind: "hook_result",
    label: hookResultLabel(result, failedOpen),
    hookEventName,
    failedOpen,
    raw: { hookEventName, result, failedOpen },
  };
}

export function activityFromWarning(event: ElwoodWarningEvent): ElwoodActivityEvent {
  return {
    elwoodSessionId: event.elwoodSessionId,
    agent: event.agent,
    source: event.source,
    kind: "warning",
    label: event.code,
    text: event.message,
    raw: event,
  };
}

export {
  activityFromClaudeTranscript,
  activityFromCodexTranscript,
} from "./transcript.ts";

function withText(
  base: Omit<ElwoodActivityEvent, "kind" | "label" | "text">,
  kind: ElwoodActivityKind,
  label: string,
  text: string,
): ElwoodActivityEvent {
  return { ...base, kind, label, text };
}
