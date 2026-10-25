/**
 * The detached sweep's kill pass (PRD §5.3 and §9.4, C-LIFE-10): SIGKILLs every group
 * the sweep signaled, deepest first, so each group's stopped parent outlives it and
 * keeps its id held through the signal. A failed kill never skips the rest. macOS
 * refuses a signal to a group whose members are all unreaped zombies with `EPERM`, and
 * a group can become one between its stop and its kill. So an `EPERM` is ignored only
 * when a fresh read, inside the sweep's deadline, succeeds and shows no live member of
 * that group; a read that cannot be had in time, or fails, leaves it a failure, and a
 * failed read is reported too, after the refusal (`confirmLiveGroups`).
 */

import { errnoCode } from "../../../core/errors.ts";
import type { SweepOps, SweepState } from "./rounds.ts";

export async function killSignaledGroups(
  ops: SweepOps,
  state: SweepState,
  deadline: number,
): Promise<void> {
  const refused = new Map<number, unknown>();
  for (const group of [...state.signaledDescendants].reverse()) {
    try {
      ops.killGroup(group);
    } catch (error) {
      if (errnoCode(error) === "EPERM") refused.set(group, error);
      else state.failures.record("could not kill a signaled descendant group", error, [group]);
    }
  }
  if (refused.size === 0) return;
  const confirmation = await confirmLiveGroups(ops, deadline);
  for (const [group, error] of refused) {
    if (!confirmedGone(confirmation, group)) {
      state.failures.record("could not kill a signaled descendant group", error, [group]);
    }
  }
  recordFailedRead(confirmation, state, [...refused.keys()]);
}

/** A fresh read's groups with a live member, or why there is none: no time, or its error. */
export type Confirmation =
  | { readonly kind: "read"; readonly live: ReadonlySet<number> }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "no time" };

/** Takes a fresh read inside `deadline`, to judge a signal refused with `EPERM`. */
export async function confirmLiveGroups(ops: SweepOps, deadline: number): Promise<Confirmation> {
  const remainingMs = Math.ceil(deadline - performance.now());
  if (remainingMs <= 0) return { kind: "no time" };
  try {
    const table = await ops.listProcesses(remainingMs);
    return {
      kind: "read",
      live: new Set(table.filter((row) => !row.zombie).map((row) => row.pgid)),
    };
  } catch (error) {
    return { kind: "failed", error };
  }
}

/** Whether `confirmation` is a read that shows no live member of `group`. */
export function confirmedGone(confirmation: Confirmation, group: number): boolean {
  return confirmation.kind === "read" && !confirmation.live.has(group);
}

/** Records a confirming read that failed against `groups`, after the refusals it judged. */
export function recordFailedRead(
  confirmation: Confirmation,
  state: SweepState,
  groups: readonly number[],
): void {
  if (confirmation.kind === "failed") {
    state.failures.record("process table unreadable", confirmation.error, groups);
  }
}
