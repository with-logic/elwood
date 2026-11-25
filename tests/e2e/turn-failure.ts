/**
 * Reads a raw session's recorded activity for the real-CLI `turn_failure` proofs (PRD §5.4,
 * C-API-65): which activity is the failure, where the failed turn's `ready` landed, and what
 * the session had seen when a wait times out.
 */

import type { ElwoodActivityEvent, ElwoodSessionStatus } from "../../src/index.ts";
import type { ObservedSession } from "./helpers.ts";
import { waitFor } from "./wait-for.ts";

type TurnFailureEvent = Extract<ElwoodActivityEvent, { readonly kind: "turn_failure" }>;

export const isTurnFailure = (event: ElwoodActivityEvent): event is TurnFailureEvent =>
  event.kind === "turn_failure";

const isStatus = (event: ElwoodActivityEvent, status: ElwoodSessionStatus) =>
  event.kind === "status" && event.status === status;

/**
 * The index of the first `ready` after the first `running` at or after `turnStartIndex`: where
 * a consumer that ends a turn on `ready` stops listening.
 */
export function turnReadyIndex(
  activities: readonly ElwoodActivityEvent[],
  turnStartIndex: number,
): number | undefined {
  const running = activities.findIndex(
    (event, at) => at >= turnStartIndex && isStatus(event, "running"),
  );
  const ready = activities.findIndex((event, at) => at > running && isStatus(event, "ready"));
  return running < 0 || ready < 0 ? undefined : ready;
}

/** How long a real turn may take to reach `ready`: a launch, a submit, and a model round trip. */
export const turnReadyWaitMs = 90_000;

/**
 * How long the failure evidence may take after `ready`: the screen outruns the hook or the
 * transcript flush, so this wait only has to cover that lag.
 */
export const turnFailureWaitMs = 60_000;

/**
 * Wraps `waitFor`, adding what the session had observed (status, hooks, activity, warnings)
 * to a timeout's error, so CLI drift is diagnosable. The original error stays as `cause`.
 */
export async function waitWithEvidence<T>(
  read: () => T | undefined,
  label: string,
  timeoutMs: number,
  session: { readonly status: ElwoodSessionStatus },
  observed: ObservedSession,
): Promise<T> {
  try {
    return await waitFor(read, label, timeoutMs);
  } catch (error) {
    const seen = [
      `status ${session.status}`,
      `hooks ${observed.hooks.map((event) => event.hook_event_name).join(",")}`,
      `activity ${observed.activities.map((event) => `${event.kind}/${event.label}`).join(",")}`,
      `warnings ${observed.warnings.map((event) => event.code).join(",")}`,
      `hook errors ${observed.hookErrors.length}`,
    ];
    throw new Error(`Timed out waiting for ${label}; saw ${seen.join("; ")}`, { cause: error });
  }
}
