/** Completion-aware acquisition of the global update lease (PRD §9.2, C-PERF-04). */
import { unlink } from "node:fs/promises";
import { elwoodError, errnoCode } from "../../core/errors.ts";
import { completionSnapshot, readCompletionGeneration } from "./completion.ts";
import type { UpdateAdapter } from "./lock.ts";
import { type LeaseOwner, readOptionalText, releaseLease } from "./owner.ts";
import { pathExists, recoveryPath, type UpdateWaitResult, waitForOwner } from "./waiting.ts";

type Acquisition = {
  readonly adapter: UpdateAdapter;
  readonly leasePath: string;
  readonly owner: LeaseOwner;
  readonly completionMarkerPath: string;
  readonly refusalMarkerPath: string;
  readonly pollMs: number;
  readonly staleMs: number;
  readonly waitUntilMs: number;
  readonly claim: () => Promise<boolean>;
};

/** "uncontended" attests no observed peer or recorded outcome; false skips the update. */
export async function acquireUpdateLease({
  adapter,
  leasePath,
  owner,
  completionMarkerPath,
  refusalMarkerPath,
  pollMs,
  staleMs,
  waitUntilMs,
  claim,
}: Acquisition): Promise<false | "uncontended" | "uncertain"> {
  const {
    ownerGeneration: observedGeneration,
    priorCompletionGeneration,
    ownerAlreadyCompleted,
  } = await completionSnapshot(leasePath, completionMarkerPath);
  let latestGeneration = observedGeneration;
  // Refusal authority belongs only to the latest observed owner.
  const rejectRefusal = async () => {
    const matchesReceipt =
      latestGeneration !== undefined &&
      (await readOptionalText(refusalMarkerPath)) === latestGeneration;
    const completionUnchanged =
      matchesReceipt &&
      (await readCompletionGeneration(completionMarkerPath)) === priorCompletionGeneration;
    if (completionUnchanged) {
      throw elwoodError(
        `${adapter}_update_failed`,
        "Another updater refused prerequisite verification.",
        { updateReason: "peer_verification_refused" },
      );
    }
  };
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
    const observation = await waitForOwner(
      leasePath,
      pollMs,
      staleMs,
      waitUntilMs,
      latestGeneration,
    );
    if ("generation" in observation) {
      latestGeneration = observation.generation;
      await rejectRefusal();
    }
    const waited = recoveredWait(adapter, observation);
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
    if (!(observedOwnerCompleted || completionAdvanced)) await rejectRefusal();
    return false;
  }
  const clearedRefusal = await unlink(refusalMarkerPath)
    .then(() => true)
    .catch(async (error: unknown) => {
      if (errnoCode(error) === "ENOENT") return false;
      await releaseLease(leasePath, owner);
      throw error;
    });
  return observedActive || priorCompletionGeneration !== undefined || clearedRefusal
    ? "uncertain"
    : "uncontended";
}

/** A nonoptional return and no default make future wait variants a compile-time error. */
function recoveredWait(
  adapter: UpdateAdapter,
  result: UpdateWaitResult,
): false | Extract<UpdateWaitResult, { readonly generation: string | undefined }> {
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
