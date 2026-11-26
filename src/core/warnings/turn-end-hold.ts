/**
 * The content-free diagnostic for Claude's turn-end hold reaching its limit while input it
 * held still waited on a busy or unrecognized screen (PRD §5.3, §5.7, C-ATTN-10).
 */
export type TurnEndHoldExpiredWarning = {
  readonly elwoodSessionId: string;
  readonly agent: "claude";
  readonly source: "terminal";
  readonly code: "turn_end_hold_expired";
  readonly severity: "warning";
  readonly message: "Queued input was released at the turn-end hold's limit, without a stable composer frame.";
  readonly raw: "turn_end_hold_expired";
};

export function turnEndHoldExpiredWarning(elwoodSessionId: string): TurnEndHoldExpiredWarning {
  return Object.freeze({
    elwoodSessionId,
    agent: "claude",
    source: "terminal",
    code: "turn_end_hold_expired",
    severity: "warning",
    message:
      "Queued input was released at the turn-end hold's limit, without a stable composer frame.",
    raw: "turn_end_hold_expired",
  });
}
