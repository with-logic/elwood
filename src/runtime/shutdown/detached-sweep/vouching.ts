/**
 * Which recorded survivor groups an ambiguous member makes unsafe to signal (PRD §5.3,
 * C-LIFE-10). A verified member alive in the same read vouches for its group: `setpgid` only
 * lets a process join a group in its own session, and a live member pins the pgid against
 * reuse, so the group holds only processes of the session that member's tree started.
 */

import type { ProcessEntry } from "../process-table.ts";

/** The groups of `survivors` with an ambiguous member and no verified member to vouch for it. */
export function unvouchedAmbiguousGroups(
  survivors: readonly ProcessEntry[],
  isAmbiguous: (row: ProcessEntry) => boolean,
): Set<number> {
  const vouched = new Set(survivors.filter((row) => !isAmbiguous(row)).map((row) => row.pgid));
  return new Set(
    survivors.filter((row) => isAmbiguous(row) && !vouched.has(row.pgid)).map((row) => row.pgid),
  );
}
