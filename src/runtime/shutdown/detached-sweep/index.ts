/**
 * Stops and SIGKILLs every process group a LIVE PTY leader's linked descendants have
 * moved into, before Elwood kills the leader. Implements PRD §5.3 and §9.4 (C-LIFE-10).
 * Claude and Codex start each hook command with `setsid()`, so a hook in flight at
 * teardown sits in its own session and process group: the leader-group SIGKILL misses
 * it, and once the leader dies the hook is reparented to PID 1 and nothing links it to
 * the session any more. The walk therefore has to happen first. It finds only what is
 * still linked by parent pid (see `detachedDescendantGroups`).
 *
 * A group id read from the table is a snapshot, free for reuse once the group is gone,
 * and a `kill()` that returns has only sent the SIGSTOP. So the sweep acts only on what
 * two consecutive reads show (see `rounds.ts`): a group is stopped once a parent of one
 * of its members is held, stopped in this read and the one before inside a group the
 * sweep stopped; and the walk ends only on a read that leaves no live group unreached
 * while every live member of every stopped group, the leader's included, is held. With
 * no hook in flight that takes two reads; each level of nesting adds two more. Then the
 * stopped groups are SIGKILLed deepest first (`kill.ts`). (A parent that ignores SIGCHLD
 * would have its exited children reaped while stopped; the CLIs and hook shells don't.)
 */

import { detachedDescendantGroups } from "../process-table.ts";
import { type SweepFailure, SweepFailures } from "./failures.ts";
import { killStoppedGroups } from "./kill.ts";
import {
  newSweepState,
  type SweepOps,
  type SweepState,
  stopAnchoredGroups,
  unheldGroups,
  unreachedGroups,
} from "./rounds.ts";

export type { SweepOps } from "./rounds.ts";

/** The whole sweep's deadline. A few `ps` reads normally finish well inside it. */
export const DETACHED_SWEEP_BUDGET_MS = 3_000;

/**
 * Sweeps `leaderPid`'s detached descendant groups and resolves to the unresolved
 * failure, or `undefined` once every group found was killed. The leader's own group is
 * left to the group reap. `leaderExited` is read before the first signal and after each
 * table read: once the leader has exited its pid may be reused, so the sweep stops no
 * further group and never signals the leader's group again, though it still SIGKILLs
 * the groups it already stopped. These are failures: an unreadable table; the deadline
 * passing while a live group is unreached or a stopped one is not yet held; the leader
 * exiting while a found group is unreached; a live group that could not be stopped or
 * killed; and a live group left unreachable because the leader's group could not be
 * stopped.
 */
export async function sweepDetachedGroups(
  leaderPid: number,
  ops: SweepOps,
  leaderExited: () => boolean,
  budgetMs: number = DETACHED_SWEEP_BUDGET_MS,
): Promise<SweepFailure | undefined> {
  if (leaderExited()) return undefined;
  const deadline = performance.now() + budgetMs;
  const state = newSweepState(new SweepFailures());
  let leaderStop: { readonly error: unknown } | undefined;
  try {
    ops.stopGroup(leaderPid);
    state.frozen.add(leaderPid);
  } catch (error) {
    leaderStop = { error };
  }
  await stopDescendantGroups(leaderPid, ops, leaderExited, deadline, state);
  await killStoppedGroups(ops, state, deadline);
  for (const [group, error] of state.unstoppable) {
    if (state.live.has(group))
      state.failures.record("could not stop a live descendant group", error, [group]);
  }
  const unreached = unreachedGroups(state);
  if (leaderStop !== undefined && unreached.length > 0)
    state.failures.record("could not stop the leader's group", leaderStop.error, unreached);
  return state.failures.result();
}

/**
 * Reads the table round by round until `deadline`, recording into `state`: each read
 * refreshes `live` and `unheld`, then stops the unreached groups a held parent anchors.
 * It returns once a read leaves no live group unreached and every frozen group held, so
 * nothing the sweep stopped could have started a process that read missed. It also
 * returns when no unreached group can still become reachable and every frozen group is
 * held, leaving the caller to judge what remains, and when the leader has exited with
 * nothing found unreached. It records a failure and returns when the table cannot be
 * read, when the deadline passes first, or when the leader exits with a group unreached.
 */
async function stopDescendantGroups(
  leaderPid: number,
  ops: SweepOps,
  leaderExited: () => boolean,
  deadline: number,
  state: SweepState,
): Promise<void> {
  try {
    while (true) {
      const remainingMs = Math.ceil(deadline - performance.now());
      if (remainingMs <= 0) return recordDeadline(state);
      const table = await ops.listProcesses(remainingMs);
      state.live = detachedDescendantGroups(table, { leaderPid, hostPid: process.pid });
      state.unheld = unheldGroups(table, state);
      const unreached = unreachedGroups(state);
      if (unreached.length === 0 && state.unheld.length === 0) return;
      if (leaderExited()) {
        if (unreached.length === 0) return;
        const reason = "the leader exited before every descendant group was stopped";
        return state.failures.record(reason, undefined, unreached);
      }
      const reachable = stopAnchoredGroups(unreached, table, ops, state);
      if (!reachable && state.unheld.length === 0) return;
    }
  } catch (error) {
    state.failures.record("process table unreadable", error, unreachedGroups(state));
  }
}

function recordDeadline(state: SweepState): void {
  const groups = [...unreachedGroups(state), ...state.unheld];
  state.failures.record("process groups not confirmed stopped by the deadline", undefined, groups);
}
