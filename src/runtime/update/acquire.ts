/** Completion-aware lease acquisition, retrying a peer's no-start refusal (PRD §9.2). */
import { elwoodError } from "../../core/errors.ts";
import type { UpdateAdapter } from "./lock.ts";
import { type LeaseOwner, readOptionalText, releaseLease } from "./owner.ts";
import { waitForOwner } from "./waiting.ts";

type Acquisition = {
  readonly adapter: UpdateAdapter;
  readonly path: string;
  readonly owner: LeaseOwner;
  readonly completion: string;
  readonly priorCompletion: string | undefined;
  readonly pollMs: number;
  readonly staleMs: number;
  readonly waitUntilMs: number;
  readonly claim: () => Promise<"claimed" | "contended" | "unavailable">;
};

/** False means an unavailable lease or a peer's completed attempt; true grants ownership. */
export async function acquireUpdateLease({
  adapter,
  path,
  owner,
  completion,
  priorCompletion,
  pollMs,
  staleMs,
  waitUntilMs,
  claim,
}: Acquisition): Promise<boolean> {
  let recoveredStale = false;
  for (;;) {
    const claimed = await claim();
    if (claimed === "unavailable") return false;
    if (claimed === "claimed") break;
    const waited = await waitForOwner(path, pollMs, staleMs, waitUntilMs);
    if (waited === "unrecoverable") return false;
    if (waited === "released") {
      if ((await readOptionalText(completion)) !== priorCompletion) return false;
      continue; // No completed attempt: acquire the lease and use this launch's directory.
    }
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
  if (!recoveredStale && (await readOptionalText(completion)) !== priorCompletion) {
    await releaseLease(path, owner);
    return false;
  }
  return true;
}
