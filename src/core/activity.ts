/**
 * Unified activity events shared across agent adapters.
 * Implements PRD §5.4.
 */

import type { ClaudeHookEvent } from "../claude/hooks.ts";
import type { CodexHookEvent } from "../codex/hooks.ts";
import * as meta from "./activity-meta.ts";
import { hookResultLabel } from "./hook-result.ts";
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
    status,
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
    exitCode,
  };
}

export function activityFromHook(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  event: ClaudeHookEvent | CodexHookEvent,
): ElwoodActivityEvent {
  const base = meta.hookActivityBase(agent, elwoodSessionId, event);
  if (event.hook_event_name === "UserPromptSubmit") {
    return withText(base, "user_message", "user", event.prompt);
  }
  if (event.hook_event_name === "Notification") {
    return withText(base, "notification", event.notification_type, event.message);
  }
  if (event.hook_event_name === "PreToolUse" || event.hook_event_name === "PermissionRequest") {
    return toolActivity(base, "tool_call", event, meta.hookToolInput(event));
  }
  if (event.hook_event_name === "PostToolUse" || event.hook_event_name === "PostToolBatch") {
    return toolActivity(base, "tool_result", event, meta.hookToolOutput(event));
  }
  // Claude sources assistant_message from the committed transcript (C-CLAUDE-15),
  // so a Stop hook's last_assistant_message — which can carry an un-sent
  // ghost-text suggestion — is NOT emitted as a message here; the Stop hook
  // stays a turn-boundary signal. Codex has no transcript-backed Claude path, so
  // its stop message remains the assistant_message source.
  const text = agent === "codex" ? meta.stopMessage(event) : undefined;
  if (text !== undefined) {
    return withText(base, "assistant_message", event.hook_event_name, text);
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
} from "./activity-transcript.ts";

function withText(
  base: Omit<ElwoodActivityEvent, "kind" | "label" | "text">,
  kind: ElwoodActivityKind,
  label: string,
  text: string,
): ElwoodActivityEvent {
  return { ...base, kind, label, text };
}

function toolActivity(
  base: Omit<ElwoodActivityEvent, "kind" | "label" | "text">,
  kind: "tool_call" | "tool_result",
  event: ClaudeHookEvent | CodexHookEvent,
  io: Partial<ElwoodActivityEvent>,
): ElwoodActivityEvent {
  return { ...base, kind, label: base.toolName ?? event.hook_event_name, ...io };
}
