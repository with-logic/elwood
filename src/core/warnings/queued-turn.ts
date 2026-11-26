/**
 * The content-free diagnostic for a Claude `Stop` held for queued guidance that reached its hang
 * limit with neither the queued turn's `Stop` nor an idle composer (PRD §6.5, §5.7, C-HOOK-24).
 */
import type { ClaudeQueuedTurnUnconfirmedWarning } from "./lifecycle.ts";

export function queuedTurnUnconfirmedWarning(
  elwoodSessionId: string,
): ClaudeQueuedTurnUnconfirmedWarning {
  return Object.freeze({
    elwoodSessionId,
    agent: "claude",
    source: "lifecycle",
    code: "queued_turn_unconfirmed",
    severity: "warning",
    message:
      "Claude did not finish the guidance queued at its Stop within the limit, so Elwood released that Stop.",
    raw: "queued_turn_unconfirmed",
  });
}
