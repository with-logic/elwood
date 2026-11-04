/** Completion-aware acquisition of the global update lease (PRD §9.2, C-PERF-04). */
import { unlink } from "node:fs/promises";
import { elwoodError, errnoCode } from "../../core/errors.ts";
import type { UpdateSkipReason } from "../../core/warnings/update-skips.ts";
import { unconfirmedPeerUpdate } from "../../core/warnings/update-unconfirmed.ts";
import {
  completionSnapshot,
  consumeMismatchedReceipt,
  observePeerCompletion,
  type PeerCompletionEvidence,
} from "./completion.ts";
import type { UpdateAdapter } from "./lock.ts";
import type { UpdateNotStarted } from "./not-started.ts";
import { type LeaseOwner, readOptionalText, releaseLease } from "./owner.ts";
import { confirmAcquiredLease, excludedPeerOutcome, releasedPeerOutcome } from "./peer-outcome.ts";
import { pathExists, recoveryPath, type UpdateWaitResult, waitForOwner } from "./waiting.ts";

type Acquisition = {
  readonly adapter: UpdateAdapter;
  readonly leasePath: string;
  readonly owner: LeaseOwner;
  readonly completionMarkerPath: string;
  readonly refusalReceiptPath: string;
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

type ClaimResult = "acquired" | "wait" | "peer" | "unconfirmed" | "not-started";
const claimRoutes = {
  acquired: true,
  wait: "wait",
  peer: false,
  unconfirmed: "unconfirmed",
  "not-started": { started: false },
} as const satisfies Readonly<
  Record<ClaimResult, boolean | UpdateNotStarted | "wait" | "unconfirmed">
>;

/** True owns the lease; false preserves peer exclusion; no-attempt is retryable. */
export async function acquireUpdateLease({
  adapter,
  leasePath,
  owner,
  completionMarkerPath,
  refusalReceiptPath,
  pollMs,
  staleMs,
  waitUntilMs,
  claim,
}: Acquisition): Promise<boolean | UpdateNotStarted> {
  const snapshot = await completionSnapshot(leasePath, completionMarkerPath).catch(() => {
    throw unconfirmedPeerUpdate(adapter);
  });
  const { ownerGeneration } = snapshot;
  const observedGenerations = new Set(ownerGeneration === undefined ? [] : [ownerGeneration]);
  let latestObservedOwnerGeneration = ownerGeneration;
  const peerCompletion = () =>
    observePeerCompletion(snapshot, observedGenerations, completionMarkerPath).catch(() => {
      throw unconfirmedPeerUpdate(adapter);
    });
  const hasLatestOwnerNoAttemptReceipt = async () => {
    const marker = await readOptionalText(refusalReceiptPath);
    return latestObservedOwnerGeneration !== undefined && marker === latestObservedOwnerGeneration;
  };
  let hasObservedActiveOwner = ownerGeneration !== undefined;
  let recoveredStale = false;
  const hasUnconfirmedPeerAttempt = async () =>
    hasObservedActiveOwner && !(await hasLatestOwnerNoAttemptReceipt());
  for (;;) {
    const claimed =
      claimRoutes[await classifyClaim(claim, leasePath, peerCompletion, hasUnconfirmedPeerAttempt)];
    if (claimed === true) break;
    if (claimed === "unconfirmed") throw unconfirmedPeerUpdate(adapter);
    if (claimed !== "wait") return claimed;
    hasObservedActiveOwner = true;
    const waited = recoveredWait(
      adapter,
      await waitForOwner(leasePath, pollMs, staleMs, waitUntilMs, (generation) => {
        latestObservedOwnerGeneration = generation;
        if (generation !== undefined) observedGenerations.add(generation);
      }),
    );
    if (waited === false) return excludedPeerOutcome(adapter, await peerCompletion());
    if (waited.status === "released") {
      // Completion can name any observed owner. Only the latest owner's no-attempt
      // receipt grants a retry, and an eligible successor clears it before invocation.
      const disposition = await releasedPeerOutcome(
        adapter,
        await peerCompletion(),
        hasLatestOwnerNoAttemptReceipt,
      );
      if (disposition === "retry") continue;
      return false;
    }
    latestObservedOwnerGeneration = waited.generation;
    if (waited.generation !== undefined) observedGenerations.add(waited.generation);
    recoveredStale = true;
  }
  const ownsUpdate = await confirmAcquiredLease(
    adapter,
    leasePath,
    owner,
    peerCompletion,
    async () => !recoveredStale && (await hasUnconfirmedPeerAttempt()),
    () => consumeMismatchedReceipt(snapshot, completionMarkerPath, leasePath, owner),
  );
  if (!ownsUpdate) return false;
  return invalidateRefusal(refusalReceiptPath, leasePath, owner);
}

/** Recheck pinned completion and live leases after a failed staging operation. */
async function classifyClaim(
  claim: Acquisition["claim"],
  leasePath: string,
  peerCompletion: () => Promise<PeerCompletionEvidence>,
  hasUnconfirmedPeerAttempt: () => Promise<boolean>,
): Promise<ClaimResult> {
  const disposition = claimDisposition[await claim()];
  if (disposition !== "not-started") return disposition;
  // A sweeping peer may have retired before the missing staging error was handled.
  // Still-live peers must settle before compatibility reads; completed peers invalidate caches.
  if ((await pathExists(leasePath)) || (await pathExists(recoveryPath(leasePath)))) return "wait";
  const evidence = await peerCompletion();
  if (evidence === "confirmed") return "peer";
  if (evidence === "unconfirmed" || (await hasUnconfirmedPeerAttempt())) return "unconfirmed";
  return "not-started";
}

/** An eligible successor clears prior evidence before a poller could miss its update. */
async function invalidateRefusal(
  refusalReceiptPath: string,
  leasePath: string,
  owner: LeaseOwner,
): Promise<true | UpdateNotStarted> {
  try {
    await unlink(refusalReceiptPath);
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
        updateReason: "active_owner" satisfies UpdateSkipReason,
      });
    case "cleanup_pending":
      throw elwoodError(
        `${adapter}_update_failed`,
        "Another updater's process group has not exited.",
        {
          updateReason: "cleanup_pending" satisfies UpdateSkipReason,
          cleanupErrorCode: "ETIMEDOUT",
        },
      );
    case "stale_removed":
      return result;
  }
}
