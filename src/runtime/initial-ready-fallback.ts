/**
 * The durable, content-free warning for a fallback initial-ready transition.
 * Implements PRD §5.3 and C-API-42: when recording a session's one-shot initial-ready
 * transition throws, Elwood still releases the control queue directly so queued input
 * is never starved, but persisted status and emitted lifecycle events may be stale.
 * This surfaces that risk as a typed `initial_ready_fallback` warning carrying only a
 * bounded reason — never a raw system message or session content. Both adapters.
 */

import type { ElwoodAgentKind } from "../core/activity.ts";
import type { ElwoodWarningEvent, InitialReadyFallbackReason } from "../core/types.ts";

export function initialReadyFallbackWarning(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  reason: InitialReadyFallbackReason,
): ElwoodWarningEvent {
  return {
    elwoodSessionId,
    agent,
    source: "lifecycle",
    code: "initial_ready_fallback",
    severity: "warning",
    message: `Recording the initial-ready transition failed (${reason}); released the queue directly, so persisted status and lifecycle events may be stale.`,
    reason,
    raw: `initial_ready_fallback reason=${reason}`,
  };
}
