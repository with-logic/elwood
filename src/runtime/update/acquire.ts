/** Completion-aware acquisition of the global update lease (PRD §9.2, C-PERF-04). */
import { elwoodError } from "../../core/errors.ts";
import { completionSnapshot, readCompletionGeneration } from "./completion.ts";
import type { UpdateAdapter } from "./lock.ts";
import { type LeaseOwner, releaseLease } from "./owner.ts";
import { pathExists, recoveryPath, type UpdateWaitResult, waitForOwner } from "./waiting.ts";

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
  const {
    ownerGeneration: observedGeneration,
    priorCompletionGeneration,
    ownerAlreadyCompleted,
  } = await completionSnapshot(leasePath, completionMarkerPath);
  const observedGenerations = new Set(observedGeneration === undefined ? [] : [observedGeneration]);
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
    const waited = recoveredWait(
      adapter,
      await waitForOwner(leasePath, pollMs, staleMs, waitUntilMs),
    );
    if (waited === false) return false;
    if (waited.generation !== undefined) observedGenerations.add(waited.generation);
    recoveredStale = true;
  }
  let currentCompletionGeneration: string | undefined;
  try {
    currentCompletionGeneration = await readCompletionGeneration(completionMarkerPath);
  } catch (error) {
    await releaseLease(leasePath, owner);
    throw error;
  }
  const observedOwnerCompleted =
    ownerAlreadyCompleted ||
    (currentCompletionGeneration !== undefined &&
      observedGenerations.has(currentCompletionGeneration));
  const completionAdvanced = currentCompletionGeneration !== priorCompletionGeneration;
  const unrecoveredContention = !recoveredStale && observedActive;
  if (observedOwnerCompleted || completionAdvanced || unrecoveredContention) {
    await releaseLease(leasePath, owner);
    return false;
  }
  return true;
}

/** A nonoptional return and no default make future wait variants a compile-time error. */
function recoveredWait(
  adapter: UpdateAdapter,
  result: UpdateWaitResult,
): false | Extract<UpdateWaitResult, { readonly status: "stale_removed" }> {
  switch (result.status) {
    case "released":
      return false;
    case "wait_expired":
      throw elwoodError(`${adapter}_update_failed`, "Another updater has not finished.", {
        updateReason: "active_owner",
      });
    case "cleanup_pending":
      throw elwoodError(
        `${adapter}_update_failed`,
        "Another updater's process group has not exited.",
        { updateReason: "cleanup_pending", cleanupErrorCode: "ETIMEDOUT" },
      );
    case "stale_removed":
      return result;
  }
}
