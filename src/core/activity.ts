/**
 * Unified activity events shared across agent adapters.
 * Implements PRD §5.4.
 */

import type { ClaudeHookEvent } from "../claude/hooks.ts";
import type { CodexHookEvent } from "../codex/hooks.ts";
import type { CodexTranscriptEvent } from "../codex/transcript.ts";
import { hookResultLabel, transcriptActivityKind } from "./hook-result.ts";
import type { ElwoodSessionStatus, ElwoodWarningEvent, HookErrorEvent } from "./types.ts";

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
  | "notification"
  | "warning"
  | "startup_prompt"
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
  readonly raw?: unknown;
};

export function activityFromStatus(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  status: ElwoodSessionStatus,
): ElwoodActivityEvent {
  return {
    elwoodSessionId,
    agent,
    source: "lifecycle",
    kind: "status",
    label: status,
  };
}

export function activityFromTerminalExit(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  exitCode: number,
): ElwoodActivityEvent {
  return {
    elwoodSessionId,
    agent,
    source: "lifecycle",
    kind: "terminal_exit",
    label: `${exitCode}`,
  };
}

export function activityFromHook(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  event: ClaudeHookEvent | CodexHookEvent,
): ElwoodActivityEvent {
  const base = { elwoodSessionId, agent, source: "hook" as const, raw: event };
  if (event.hook_event_name === "UserPromptSubmit") {
    return withText(base, "user_message", "user", event.prompt);
  }
  if (event.hook_event_name === "Notification") {
    return withText(base, "notification", event.notification_type, event.message);
  }
  if (event.hook_event_name === "PreToolUse" || event.hook_event_name === "PermissionRequest") {
    return { ...base, kind: "tool_call", label: toolName(event) };
  }
  if (event.hook_event_name === "PostToolUse" || event.hook_event_name === "PostToolBatch") {
    return { ...base, kind: "tool_result", label: toolName(event) };
  }
  if (
    event.hook_event_name === "Stop" ||
    event.hook_event_name === "SubagentStop" ||
    event.hook_event_name === "StopFailure"
  ) {
    const text = stringValue(record(event)["last_assistant_message"]);
    if (text) {
      return withText(base, "assistant_message", event.hook_event_name, text);
    }
  }
  return { ...base, kind: "hook", label: event.hook_event_name };
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

export function activityFromStartupPrompt(
  elwoodSessionId: string,
  label: string,
  input: string,
): ElwoodActivityEvent {
  return {
    elwoodSessionId,
    agent: "codex",
    source: "terminal",
    kind: "startup_prompt",
    label,
    text: `Detected Codex ${label} prompt; sent ${input}.`,
  };
}

export function activityFromCodexTranscript(event: CodexTranscriptEvent): ElwoodActivityEvent {
  return {
    elwoodSessionId: event.elwoodSessionId,
    agent: "codex",
    source: "transcript",
    kind: transcriptActivityKind(event.summary.kind) as ElwoodActivityKind,
    label: event.summary.label,
    ...(event.summary.text === undefined ? {} : { text: event.summary.text }),
    raw: event.item,
  };
}

function withText(
  base: Pick<ElwoodActivityEvent, "elwoodSessionId" | "agent" | "source" | "raw">,
  kind: ElwoodActivityKind,
  label: string,
  text: string,
): ElwoodActivityEvent {
  return { ...base, kind, label, text };
}

function toolName(event: ClaudeHookEvent | CodexHookEvent): string {
  return stringValue(record(event)["tool_name"]) ?? event.hook_event_name;
}

function record(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
