/**
 * Hands a lease whose updater groups outlived the update callback over to those groups.
 * Implements PRD §9.2 / C-PERF-04: a cleanup record that cannot be written never strands
 * the lease for the owner host's lifetime.
 */
import { setTimeout as delay } from "node:timers/promises";
import { processGroupGone } from "../probe-cleanup.ts";
import { type LeaseOwner, releaseLease, retainProbeOwner } from "./owner.ts";

/**
 * Records the surviving groups as the lease's only holders, so the lease outlives this
 * process and a contender waits for the groups rather than for a pid that has moved on.
 *
 * When that write fails the lease still names this live process, which contenders would
 * honour for as long as this host runs — long after the groups exit. This process therefore
 * keeps the obligation itself: it retries the record and, as soon as the groups are gone,
 * releases the lease. The timer is unreferenced, so a host that is shutting down is never
 * held open by it.
 */
export async function retainLease(
  path: string,
  owner: LeaseOwner,
  processGroupIds: readonly number[],
  retryMs: number,
): Promise<void> {
  try {
    await retainProbeOwner(path, owner, processGroupIds);
  } catch {
    void retainUntilRecorded(path, owner, processGroupIds, retryMs);
  }
}

async function retainUntilRecorded(
  path: string,
  owner: LeaseOwner,
  processGroupIds: readonly number[],
  retryMs: number,
): Promise<void> {
  for (;;) {
    await delay(retryMs, undefined, { ref: false });
    const live = processGroupIds.filter((id) => !processGroupGone(id));
    // `releaseLease` is generation-checked and contains its own filesystem failures, so a
    // successor that has since claimed the lease is never disturbed by this.
    if (live.length === 0) return releaseLease(path, owner);
    const recorded = await retainProbeOwner(path, owner, live).then(
      () => true,
      () => false,
    );
    if (recorded) return;
  }
}
