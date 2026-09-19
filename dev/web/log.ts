/**
 * Hook event summaries for the browser dev app log.
 * Implements PRD §6 and §11.
 */

import { stopFailureDetails, stopFailureError } from "../../src/claude/hooks/events.ts";
import type { AgentHookEvent } from "../agent-runtime.ts";

export function summarizeHookEvent(event: AgentHookEvent): string {
  if (event.hook_event_name === "Stop" && event.last_assistant_message) {
    return `hook Stop: ${truncate(event.last_assistant_message)}`;
  }
  if (event.hook_event_name === "SubagentStop" && event.last_assistant_message) {
    return `hook SubagentStop ${event.agent_type}: ${truncate(event.last_assistant_message)}`;
  }
  if (event.hook_event_name === "StopFailure") {
    // Mirror the failure reader's precedence: a non-blank `error_details` is the reason, else
    // the named error, else a generic fallback. Rendering `last_assistant_message` instead
    // showed a blank line for rejections that DID carry a usable detail. Fields are loose by
    // design, so narrow through the shared helpers rather than assuming strings.
    // The label is the named error (or a generic fallback when it drifted); the body prefers a
    // non-blank `error_details` — the reader's own reason — and falls back to the final
    // assistant text. Showing only `last_assistant_message` left a blank body for rejections
    // that DID carry a usable detail.
    const label = stopFailureError(event) ?? "unknown";
    const detail =
      stopFailureDetails(event) ??
      (typeof event.last_assistant_message === "string" ? event.last_assistant_message : "");
    return `hook StopFailure ${label}: ${truncate(detail)}`;
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
