/**
 * The detached sweep's kill pass (PRD §5.3 and §9.4, C-LIFE-10): SIGKILLs every group
 * the sweep stopped, deepest first, so each group's stopped parent outlives it and keeps
 * its id held through the signal. A failed kill never skips the rest. macOS refuses a
 * kill of a group whose members are all unreaped zombies with `EPERM`, and a group can
 * become one between its stop and its kill, so an `EPERM` is a failure only if a fresh
 * read, inside the sweep's deadline, still shows a live member of that group.
 */

import { errnoCode } from "../../../core/errors.ts";
import type { SweepOps, SweepState } from "./rounds.ts";

export async function killStoppedGroups(
  ops: SweepOps,
  state: SweepState,
  deadline: number,
): Promise<void> {
  const refused = new Map<number, unknown>();
  for (const group of [...state.stopped].reverse()) {
    try {
      ops.killGroup(group);
    } catch (error) {
      if (errnoCode(error) === "EPERM") refused.set(group, error);
      else state.failures.record("could not kill a stopped descendant group", error, [group]);
    }
  }
  if (refused.size === 0) return;
  const live = await liveGroups(ops, deadline);
  for (const [group, error] of refused) {
    if (live?.has(group) !== false) {
      state.failures.record("could not kill a stopped descendant group", error, [group]);
    }
  }
}

/** The groups with a live member in a fresh read, or `undefined` if none can be had in time. */
async function liveGroups(ops: SweepOps, deadline: number): Promise<Set<number> | undefined> {
  const remainingMs = Math.ceil(deadline - performance.now());
  if (remainingMs <= 0) return undefined;
  try {
    const table = await ops.listProcesses(remainingMs);
    return new Set(table.filter((row) => !row.zombie).map((row) => row.pgid));
  } catch {
    return undefined;
  }
}
