/** Completion-aware acquisition of the global update lease (PRD §9.2, C-PERF-04). */
import { elwoodError } from "../../core/errors.ts";
import type { UpdateAdapter } from "./lock.ts";
import { type LeaseOwner, readOptionalText, readOwner, releaseLease } from "./owner.ts";
import { pathExists, recoveryPath, waitForOwner } from "./waiting.ts";

type Acquisition = {
  readonly adapter: UpdateAdapter;
  readonly leasePath: string;
  readonly owner: LeaseOwner;
  readonly completionMarkerPath: string;
  readonly pollMs: number;
  readonly staleMs: number;
  readonly waitUntilMs: number;
  readonly claim: () => Promise<boolean>;
};

/** True grants update ownership; false means no update lease acquired. */
export async function acquireUpdateLease({
  adapter,
  leasePath,
  owner,
  completionMarkerPath,
  pollMs,
  staleMs,
  waitUntilMs,
  claim,
}: Acquisition): Promise<boolean> {
  // Observe the owner before its completion can be sampled and its lease retired.
  const observedGeneration = (await readOwner(leasePath))?.token;
  const priorCompletionGeneration = await readOptionalText(completionMarkerPath);
  let observedActive =
    observedGeneration !== undefined ||
    (await pathExists(leasePath)) ||
    (await pathExists(recoveryPath(leasePath)));
  let recoveredStale = false;
  while (!(await claim())) {
    // Losing the claim to an existing lease IS an observation of an active owner; a claim
    // that failed on its own staging finds no lease below and returns as released. Sampling
    // only before the loop misses a peer that claimed in the interim, and that contender
    // would then treat its own later claim as the first attempt and run a duplicate
    // update (PRD §9.2: a contender skips its duplicate attempt).
    observedActive = true;
    const waited = await waitForOwner(leasePath, pollMs, staleMs, waitUntilMs);
    if (waited === "released") return false;
    if (waited === "wait_expired") {
      throw elwoodError(`${adapter}_update_failed`, "Another updater has not finished.", {
        updateReason: "active_owner",
      });
    }
    if (waited === "cleanup_pending") {
      throw elwoodError(
        `${adapter}_update_failed`,
        "Another updater's process group has not exited.",
        { updateReason: "cleanup_pending", cleanupErrorCode: "ETIMEDOUT" },
      );
    }
    recoveredStale = true;
  }
  const currentCompletionGeneration = await readOptionalText(completionMarkerPath);
  if (
    (observedGeneration !== undefined && priorCompletionGeneration === observedGeneration) ||
    currentCompletionGeneration !== priorCompletionGeneration ||
    (!recoveredStale && observedActive)
  ) {
    await releaseLease(leasePath, owner);
    return false;
  }
  return true;
}
