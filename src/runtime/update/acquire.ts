/** Completion-aware acquisition of the global update lease (PRD §9.2, C-PERF-04). */
import { elwoodError } from "../../core/errors.ts";
import type { UpdateAdapter } from "./lock.ts";
import { type LeaseOwner, readOptionalText, readOwner, releaseLease } from "./owner.ts";
import { pathExists, recoveryPath, waitForOwner } from "./waiting.ts";

type Acquisition = {
  readonly adapter: UpdateAdapter;
  readonly path: string;
  readonly owner: LeaseOwner;
  readonly completion: string;
  readonly pollMs: number;
  readonly staleMs: number;
  readonly waitUntilMs: number;
  readonly claim: () => Promise<boolean>;
};

/** True grants ownership; false means a peer's completed update already covers this call. */
export async function acquireUpdateLease({
  adapter,
  path,
  owner,
  completion,
  pollMs,
  staleMs,
  waitUntilMs,
  claim,
}: Acquisition): Promise<boolean> {
  // Observe the owner before its completion can be sampled and its lease retired.
  const observedGeneration = (await readOwner(path))?.token;
  const priorCompletion = await readOptionalText(completion);
  let observedActive =
    observedGeneration !== undefined ||
    (await pathExists(path)) ||
    (await pathExists(recoveryPath(path)));
  let recoveredStale = false;
  while (!(await claim())) {
    // Losing the claim to an existing lease IS an observation of an active owner; a claim
    // that failed on its own staging finds no lease below and returns as released. Sampling
    // only before the loop misses a peer that claimed in the interim, and that contender
    // would then treat its own later claim as the first attempt and run a duplicate
    // update (PRD §9.2: a contender skips its duplicate attempt).
    observedActive = true;
    const waited = await waitForOwner(path, pollMs, staleMs, waitUntilMs);
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
    const staleRemoved: "stale_removed" = waited;
    recoveredStale = staleRemoved === "stale_removed";
  }
  if (
    (observedGeneration !== undefined && priorCompletion === observedGeneration) ||
    (!recoveredStale &&
      (observedActive || (await readOptionalText(completion)) !== priorCompletion))
  ) {
    await releaseLease(path, owner);
    return false;
  }
  return true;
}
