/**
 * Which recorded survivor groups an ambiguous member makes unsafe to signal (PRD §5.3,
 * C-LIFE-10). A verified member alive in the same read vouches for its group: `setpgid` only
 * lets a process join a group in its own session, and the group keeps its id while that
 * member lives, so in that read the group holds only processes of the session that
 * member's tree started.
 */

import type { ProcessEntry } from "../process-table.ts";

/** The groups of `survivors` with an ambiguous member and no verified member to vouch for it. */
export function unvouchedAmbiguousGroups(
  survivors: readonly ProcessEntry[],
  isAmbiguous: (row: ProcessEntry) => boolean,
): Set<number> {
  const unvouched = new Set<number>();
  for (const row of survivors) if (isAmbiguous(row)) unvouched.add(row.pgid);
  // Most reads have no ambiguous member, and then there is nothing to vouch for.
  if (unvouched.size === 0) return unvouched;
  for (const row of survivors) if (!isAmbiguous(row)) unvouched.delete(row.pgid);
  return unvouched;
}
