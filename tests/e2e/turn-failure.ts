/**
 * Reads a raw session's recorded activity for the real-CLI `turn_failure` proofs (PRD §5.4,
 * C-API-65): which activity is the failure, and where the failed turn's `ready` landed.
 */

import type { ElwoodActivityEvent } from "../../src/index.ts";

export type TurnFailureActivity = Extract<ElwoodActivityEvent, { readonly kind: "turn_failure" }>;

export const isTurnFailure = (event: ElwoodActivityEvent): event is TurnFailureActivity =>
  event.kind === "turn_failure";

const isStatus = (event: ElwoodActivityEvent, status: string) =>
  event.kind === "status" && event.label === status;

/** The index of the `ready` that ends the turn whose activity starts at index `sent`. */
export function turnReady(
  activities: readonly ElwoodActivityEvent[],
  sent: number,
): number | undefined {
  const running = activities.findIndex((event, at) => at >= sent && isStatus(event, "running"));
  const ready = activities.findIndex((event, at) => at > running && isStatus(event, "ready"));
  return running < 0 || ready < 0 ? undefined : ready;
}
