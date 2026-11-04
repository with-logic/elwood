/** Completion-aware acquisition of the global update lease (PRD §9.2, C-PERF-04). */
import { unlink } from "node:fs/promises";
import { elwoodError, errnoCode } from "../../core/errors.ts";
import { completionSnapshot, readCompletionGeneration } from "./completion.ts";
import type { UpdateAdapter } from "./lock.ts";
import type { UpdateNotStarted } from "./not-started.ts";
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

// Every claim outcome must choose an explicit disposition when the union grows.
const claimDisposition = {
  claimed: "acquired",
  contended: "wait",
  unavailable: "not-started",
} as const satisfies Readonly<Record<Awaited<ReturnType<Acquisition["claim"]>>, string>>;

/** True owns the lease; false preserves peer exclusion; no-attempt is retryable. */
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
}: Acquisition): Promise<boolean | UpdateNotStarted> {
  const { ownerGeneration, priorCompletionGeneration, ownerAlreadyCompleted } =
    await completionSnapshot(leasePath, completionMarkerPath);
  const observedGenerations = new Set(ownerGeneration === undefined ? [] : [ownerGeneration]);
  let relevantOwner = ownerGeneration;
  const completedOwner = (generation: string | undefined) =>
    ownerAlreadyCompleted || (generation !== undefined && observedGenerations.has(generation));
  const completed = async () => {
    const current = await readCompletionGeneration(completionMarkerPath);
    return completedOwner(current) || current !== priorCompletionGeneration;
  };
  const refused = async () => {
    const marker = await readOptionalText(refusal);
    return relevantOwner !== undefined && marker === relevantOwner;
  };
  let observedActive = ownerGeneration !== undefined;
  let recoveredStale = false;
  for (;;) {
    const claimed = claimDisposition[await claim()];
    if (claimed === "not-started") return { started: false };
    if (claimed === "acquired") break;
    observedActive = true;
    const waited = recoveredWait(
      adapter,
      await waitForOwner(leasePath, pollMs, staleMs, waitUntilMs, (generation) => {
        relevantOwner = generation;
        if (generation !== undefined) observedGenerations.add(generation);
      }),
    );
    if (waited === false) return false;
    if (waited.status === "released") {
      if ((await completed()) || !(await refused())) return false;
      continue;
    }
    relevantOwner = waited.generation;
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
  return invalidateRefusal(refusal, leasePath, owner);
}

/** An eligible successor clears prior evidence before a poller could miss its update. */
async function invalidateRefusal(
  refusal: string,
  leasePath: string,
  owner: LeaseOwner,
): Promise<true | UpdateNotStarted> {
  try {
    await unlink(refusal);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") {
      await releaseLease(leasePath, owner);
      return { started: false, error };
    }
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
