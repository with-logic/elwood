/**
 * The live, content-free warning for a fallback initial-ready transition.
 * Implements PRD §5.3 and C-API-42: when recording a session's one-shot initial-ready
 * transition throws (a lifecycle-event listener), Elwood still releases the control
 * queue directly so queued input is never starved, but emitted lifecycle events may be
 * stale. This surfaces that risk as a typed `initial_ready_fallback` warning carrying
 * no raw system message or session content. Both adapters.
 */

import type { ElwoodAgentKind } from "../core/activity.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";

export function initialReadyFallbackWarning(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
): ElwoodWarningEvent {
  return {
    elwoodSessionId,
    agent,
    source: "lifecycle",
    code: "initial_ready_fallback",
    severity: "warning",
    message:
      "Recording the initial-ready transition failed; released the queue directly, so lifecycle events may be stale.",
    raw: "initial_ready_fallback",
  };
}
