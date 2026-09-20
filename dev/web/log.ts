/**
 * Hook event summaries for the browser dev app log.
 * Implements PRD §6 and §11.
 */

import { stopFailureDiagnostic } from "../../src/claude/hooks/stop-failure.ts";
import type { AgentHookEvent } from "../agent-runtime.ts";

export function summarizeHookEvent(event: AgentHookEvent): string {
  if (event.hook_event_name === "Stop" && event.last_assistant_message) {
    return `hook Stop: ${truncate(event.last_assistant_message)}`;
  }
  if (event.hook_event_name === "SubagentStop" && event.last_assistant_message) {
    return `hook SubagentStop ${event.agent_type}: ${truncate(event.last_assistant_message)}`;
  }
  if (event.hook_event_name === "StopFailure") {
    return `hook StopFailure: ${truncate(stopFailureDiagnostic(event).message)}`;
  }
  if (event.hook_event_name === "Notification") {
    return `hook Notification ${event.notification_type}: ${truncate(event.message)}`;
  }
  if (event.hook_event_name === "PostCompact") {
    // Claude carries compact_summary; Codex carries trigger for the same hook name.
    return "compact_summary" in event
      ? `hook PostCompact: ${truncate(event.compact_summary)}`
      : `hook PostCompact: ${truncate(event.trigger)}`;
  }
  return `hook ${event.hook_event_name}`;
}

function truncate(value: string, maxLength = 160): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}
