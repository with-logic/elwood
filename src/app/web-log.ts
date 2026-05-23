/**
 * Hook event summaries for the browser dev app log.
 * Implements PRD §6 and §10.
 */

import type { ClaudeHookEvent } from "../index.ts";

export function summarizeHookEvent(event: ClaudeHookEvent): string {
  if (event.hook_event_name === "Stop" && event.last_assistant_message) {
    return `hook Stop: ${truncate(event.last_assistant_message)}`;
  }
  if (event.hook_event_name === "SubagentStop" && event.last_assistant_message) {
    return `hook SubagentStop ${event.agent_type}: ${truncate(event.last_assistant_message)}`;
  }
  if (event.hook_event_name === "StopFailure" && event.last_assistant_message) {
    return `hook StopFailure ${event.error}: ${truncate(event.last_assistant_message)}`;
  }
  if (event.hook_event_name === "Notification") {
    return `hook Notification ${event.notification_type}: ${truncate(event.message)}`;
  }
  if (event.hook_event_name === "PostCompact") {
    return `hook PostCompact: ${truncate(event.compact_summary)}`;
  }
  return `hook ${event.hook_event_name}`;
}

function truncate(value: string, maxLength = 160): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}
