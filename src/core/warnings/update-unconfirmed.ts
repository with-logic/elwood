/** Bounded uncertainty about a peer updater preserves exclusion (PRD §9.2, C-LIFE-11). */
import type { ElwoodAgentKind } from "../activity/index.ts";
import { ElwoodError, elwoodError } from "../errors.ts";

const unconfirmedOutcome = "unconfirmed";

/** This says nothing about whether the peer invoked its updater. */
export function unconfirmedPeerUpdate(agent: ElwoodAgentKind): ElwoodError {
  return elwoodError(
    `${agent}_update_failed`,
    "Another updater's outcome could not be confirmed.",
    {
      updateOutcome: unconfirmedOutcome,
    },
  );
}

export function isUnconfirmedPeerUpdate(error: unknown): boolean {
  return error instanceof ElwoodError && error.details["updateOutcome"] === unconfirmedOutcome;
}
