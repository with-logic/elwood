/**
 * Process-group liveness for update probes: groups are observed here, never signaled.
 * Implements PRD §9.2 / C-PERF-04; a surviving updater group retains update exclusion.
 */
import { errnoCode } from "../core/errors.ts";

/**
 * Whether a process group has fully exited. Signal 0 delivers nothing — it only asks the
 * kernel whether the group could be signaled — so observing a group can never disturb it.
 * Only `ESRCH` proves absence: any other error (notably `EPERM`, a group this user may not
 * signal) means something is still there, so the group counts as live and the lease it
 * holds is kept. Guessing "gone" here would let a second updater run against a live one.
 */
export function processGroupGone(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return false;
  } catch (error) {
    return errnoCode(error) === "ESRCH";
  }
}
