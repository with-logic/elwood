/**
 * Process-group liveness for update probes: groups are observed here, never signaled.
 * Implements PRD §9.2 / C-PERF-04; a surviving updater group retains update exclusion.
 */
import { setTimeout as delay } from "node:timers/promises";
import { errnoCode } from "../core/errors.ts";

/**
 * Whether a process group has fully exited. Signal 0 delivers nothing — it only asks the
 * kernel whether the group could be signaled — so observing a group can never disturb it.
 * Only `ESRCH` proves absence: any other error (notably `EPERM`, a group this user may not
 * signal) means something is still there, so the group counts as live and the lease it
 * holds is kept. Guessing "gone" here would let a second updater run against a live one.
 */
const cleanupWindowMs = 1_000;
const cleanupRetryMs = 25;

export function processGroupGone(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return false;
  } catch (error) {
    return errnoCode(error) === "ESRCH";
  }
}

/**
 * Observes an aborted updater's groups for a short window without signaling them, and
 * returns those still live. A group that exits on its own in that window never retains the
 * lease, so an update whose descendants are merely slow to finish costs one second rather
 * than a lease the next host has to wait out.
 */
export async function waitForProbeGroups(
  processGroupIds: readonly number[],
): Promise<readonly number[]> {
  const deadline = Date.now() + cleanupWindowMs;
  let live = processGroupIds.filter((id) => !processGroupGone(id));
  while (live.length > 0 && Date.now() < deadline) {
    await delay(cleanupRetryMs);
    live = live.filter((id) => !processGroupGone(id));
  }
  return live;
}
