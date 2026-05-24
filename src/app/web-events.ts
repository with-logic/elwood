/**
 * Structured debugger events for the browser dev app.
 * Implements PRD §11.
 */

import type { ElwoodActivityEvent, ElwoodWarningEvent } from "../index.ts";
import type { AgentHookEvent, CommonEventMap } from "./agent-runtime.ts";
import { summarizeHookEvent } from "./web-log.ts";
import type { DebugEventEntry, DebugEventKind, DebugEventLevel } from "./web-messages.ts";

let sequence = 0;

export function sessionEvent(input: {
  readonly id: string;
  readonly cwd: string;
  readonly status: string;
}): DebugEventEntry {
  return entry("session", "success", "SES", "Session started", input.id, ["session"], input);
}

export function statusEvent(event: CommonEventMap["status"]): DebugEventEntry {
  return entry("status", "info", "STS", "Status", event.status, [event.status], event);
}

export function terminalExitEvent(event: CommonEventMap["terminal:exit"]): DebugEventEntry {
  const signal = event.signal === undefined ? "" : ` signal ${event.signal}`;
  const level = event.exitCode === 0 ? "info" : "warn";
  return entry(
    "terminal",
    level,
    "PTY",
    "Terminal exit",
    `exit ${event.exitCode}${signal}`,
    [],
    event,
  );
}

export function activityEvent(event: ElwoodActivityEvent): DebugEventEntry {
  return entry(
    "activity",
    activityLevel(event),
    "ACT",
    activityTitle(event),
    activitySummary(event),
    [event.agent, event.source, event.kind],
    event.raw ?? event,
  );
}

export function warningEvent(event: ElwoodWarningEvent): DebugEventEntry {
  return entry(
    "warning",
    "warn",
    "WRN",
    event.code,
    event.message,
    [event.agent, event.source],
    event,
  );
}

export function hookEvent(event: AgentHookEvent): DebugEventEntry {
  return entry(
    "hook",
    "info",
    "HOK",
    event.hook_event_name,
    summarizeHookEvent(event),
    [event.hook_event_name],
    event,
  );
}

export function hookErrorEvent(event: CommonEventMap["hookError"]): DebugEventEntry {
  return entry(
    "hookError",
    "error",
    "HER",
    `${event.hookEventName} ${event.category}`,
    event.message ?? "Hook handling failed.",
    [event.hookEventName, event.category],
    event,
  );
}

export function runtimeErrorEvent(message: string, raw: unknown = { message }): DebugEventEntry {
  return entry("error", "error", "ERR", "Runtime error", message, ["runtime"], raw);
}

function entry(
  kind: DebugEventKind,
  level: DebugEventLevel,
  badge: string,
  title: string,
  summary: string,
  tags: readonly string[],
  raw: unknown,
): DebugEventEntry {
  return {
    id: `event-${Date.now()}-${sequence++}`,
    timestamp: new Date().toISOString(),
    kind,
    level,
    badge,
    title,
    summary: truncate(summary),
    tags,
    raw,
  };
}

function activityLevel(event: ElwoodActivityEvent): DebugEventLevel {
  if (event.kind === "hook_error") return "error";
  if (event.kind === "warning") return "warn";
  if (event.kind === "status") return "success";
  return "info";
}

function activityTitle(event: ElwoodActivityEvent): string {
  if (event.kind === "assistant_message") return "Assistant message";
  if (event.kind === "user_message") return "User message";
  if (event.kind === "tool_call") return `Tool call: ${event.label}`;
  if (event.kind === "tool_result") return `Tool result: ${event.label}`;
  return event.kind.replaceAll("_", " ");
}

function activitySummary(event: ElwoodActivityEvent): string {
  return event.text ?? event.label;
}

function truncate(value: string, maxLength = 180): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}
