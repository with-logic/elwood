/** Completion-aware acquisition of the global update lease (PRD §9.2, C-PERF-04). */
import { elwoodError } from "../../core/errors.ts";
import { completionSnapshot, readCompletionGeneration } from "./completion.ts";
import type { UpdateAdapter } from "./lock.ts";
import { type LeaseOwner, readOptionalText, releaseLease } from "./owner.ts";
import { type UpdateWaitResult, waitForOwner } from "./waiting.ts";

type Acquisition = {
  readonly adapter: UpdateAdapter;
  readonly leasePath: string;
  readonly owner: LeaseOwner;
  readonly completionMarkerPath: string;
  readonly refusal: string;
  readonly pollMs: number;
  readonly staleMs: number;
  readonly waitUntilMs: number;
  readonly claim: () => Promise<"claimed" | "contended" | "unavailable">;
};

/** True grants update ownership; false means no update lease acquired. */
export async function acquireUpdateLease({
  adapter,
  leasePath,
  owner,
  completionMarkerPath,
  refusal,
  pollMs,
  staleMs,
  waitUntilMs,
  claim,
}: Acquisition): Promise<boolean> {
  const { ownerGeneration, priorCompletionGeneration, ownerAlreadyCompleted } =
    await completionSnapshot(leasePath, completionMarkerPath);
  const observedGenerations = new Set(ownerGeneration === undefined ? [] : [ownerGeneration]);
  const completedOwner = (generation: string | undefined) =>
    ownerAlreadyCompleted || (generation !== undefined && observedGenerations.has(generation));
  const completed = async () => {
    const current = await readCompletionGeneration(completionMarkerPath);
    return completedOwner(current) || current !== priorCompletionGeneration;
  };
  const refused = async () => {
    const marker = await readOptionalText(refusal);
    return marker !== undefined && observedGenerations.has(marker);
  };
  let observedActive = ownerGeneration !== undefined;
  let recoveredStale = false;
  for (;;) {
    const claimed = await claim();
    if (claimed === "unavailable") return false;
    if (claimed === "claimed") break;
    observedActive = true;
    const waited = recoveredWait(
      adapter,
      await waitForOwner(leasePath, pollMs, staleMs, waitUntilMs, (generation) => {
        if (generation !== undefined) observedGenerations.add(generation);
      }),
    );
    if (waited === false) return false;
    if (waited.status === "released") {
      if ((await completed()) || !(await refused())) return false;
      continue;
    }
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
  const observedOwnerCompleted = completedOwner(currentCompletionGeneration);
  const completionAdvanced = currentCompletionGeneration !== priorCompletionGeneration;
  const unrecoveredContention = !recoveredStale && observedActive && !(await refused());
  if (observedOwnerCompleted || completionAdvanced || unrecoveredContention) {
    await releaseLease(leasePath, owner);
    return false;
  }
  return true;
}

/** An explicit return without a default makes new wait variants a compile-time error. */
function recoveredWait(
  adapter: UpdateAdapter,
  result: UpdateWaitResult,
):
  | false
  | { readonly status: "released" }
  | Extract<UpdateWaitResult, { readonly status: "stale_removed" }> {
  switch (result.status) {
    case "released":
      return { status: "released" };
    case "unrecoverable":
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
