/**
 * Stops and SIGKILLs every process group a LIVE PTY leader's linked descendants have
 * moved into, before Elwood kills the leader. Implements PRD §5.3 and §9.4 (C-LIFE-10).
 * Claude and Codex start each hook command with `setsid()`, so a hook in flight at
 * teardown sits in its own session and process group: the leader-group SIGKILL misses
 * it, and once the leader dies the hook is reparented to PID 1 and nothing links it to
 * the session any more. The walk therefore has to happen first. It finds only what is
 * still linked by parent pid (see `detachedDescendantGroups`).
 *
 * A group id read from the table is a snapshot, free for reuse once the group is gone.
 * A stopped parent cannot reap its exited child, so the child keeps its pid and its
 * group keeps its id. But a `kill()` that returns has only sent the SIGSTOP, and a row
 * is read at its own moment, so a parent counts as stopped only once an EARLIER table
 * read showed it stopped (state `T`) in a group the sweep stopped. A group is stopped
 * only when a parent of one of its members counts as stopped that way. So each level
 * of nesting costs a read, and reads repeat until none leaves a live group unreached,
 * no group can still become reachable, or the deadline passes. Then the stopped groups
 * are SIGKILLed deepest first, so each group's stopped parent outlives it. (A parent
 * that ignores SIGCHLD would have its exited children reaped while stopped; the CLIs
 * and hook shells don't.)
 */

import { errnoCode } from "../../../core/errors.ts";
import { detachedDescendantGroups, type ProcessEntry } from "../process-table.ts";
import { type SweepFailure, SweepFailures } from "./failures.ts";

/** The process operations the sweep drives; injected so tests never touch real processes. */
export type SweepOps = {
  /** SIGSTOPs the process group `pgid`. */
  readonly stopGroup: (pgid: number) => void;
  /** SIGKILLs the process group `pgid`; tolerates an already-empty group. */
  readonly killGroup: (pgid: number) => void;
  /** Lists the host process table, rejecting after `timeoutMs`. */
  readonly listProcesses: (timeoutMs: number) => Promise<readonly ProcessEntry[]>;
};

/** The whole sweep's deadline. A few `ps` reads normally finish well inside it. */
export const DETACHED_SWEEP_BUDGET_MS = 3_000;

type SweepState = {
  /** Groups whose SIGSTOP returned: the leader's, if its stop did, and every stopped one. */
  readonly frozen: Set<number>;
  /** Descendant groups whose SIGSTOP returned, in order: SIGKILLed in reverse. */
  readonly stopped: number[];
  /** Pids an earlier read showed stopped inside a frozen group. */
  readonly confirmed: Set<number>;
  /** Groups whose SIGSTOP failed for a reason other than the group being gone. */
  readonly unstoppable: Map<number, unknown>;
  /** The live descendant groups in the latest read, each with its parents' rows. */
  live: ReadonlyMap<number, ReadonlySet<ProcessEntry>>;
  readonly failures: SweepFailures;
};

/**
 * Sweeps `leaderPid`'s detached descendant groups and resolves to the unresolved
 * failure, or `undefined` once every group found was killed. The leader's own group is
 * left to the group reap. `leaderExited` is read before the first signal and after each
 * table read: once the leader has exited its pid may be reused, so the sweep stops no
 * further group and never signals the leader's group again, though it still SIGKILLs
 * the groups it already stopped. These are failures: an unreadable table; the deadline
 * passing while a live group is unreached; the leader exiting while one is; a live
 * group that could not be stopped or killed; and a live group left unreachable because
 * the leader's group could not be stopped.
 */
export async function sweepDetachedGroups(
  leaderPid: number,
  ops: SweepOps,
  leaderExited: () => boolean,
  budgetMs: number = DETACHED_SWEEP_BUDGET_MS,
): Promise<SweepFailure | undefined> {
  if (leaderExited()) return undefined;
  const state: SweepState = {
    frozen: new Set(),
    stopped: [],
    confirmed: new Set(),
    unstoppable: new Map(),
    live: new Map(),
    failures: new SweepFailures(),
  };
  let leaderStop: { readonly error: unknown } | undefined;
  try {
    ops.stopGroup(leaderPid);
    state.frozen.add(leaderPid);
  } catch (error) {
    leaderStop = { error };
  }
  await stopDescendantGroups(leaderPid, ops, leaderExited, budgetMs, state);
  for (const group of [...state.stopped].reverse()) {
    try {
      ops.killGroup(group);
    } catch (error) {
      state.failures.record("could not kill a stopped descendant group", error, [group]);
    }
  }
  for (const [group, error] of state.unstoppable) {
    if (state.live.has(group))
      state.failures.record("could not stop a live descendant group", error, [group]);
  }
  const unreached = unreachedGroups(state);
  if (leaderStop !== undefined && unreached.length > 0)
    state.failures.record("could not stop the leader's group", leaderStop.error, unreached);
  return state.failures.result();
}

async function stopDescendantGroups(
  leaderPid: number,
  ops: SweepOps,
  leaderExited: () => boolean,
  budgetMs: number,
  state: SweepState,
): Promise<void> {
  const deadline = performance.now() + budgetMs;
  try {
    while (true) {
      const remainingMs = Math.ceil(deadline - performance.now());
      if (remainingMs <= 0) {
        const reason = "descendant groups still appearing at the deadline";
        return state.failures.record(reason, undefined, unreachedGroups(state));
      }
      const table = await ops.listProcesses(remainingMs);
      state.live = detachedDescendantGroups(table, { leaderPid, hostPid: process.pid });
      const unreached = unreachedGroups(state);
      if (unreached.length === 0) return;
      if (leaderExited()) {
        const reason = "the leader exited before every descendant group was stopped";
        return state.failures.record(reason, undefined, unreached);
      }
      if (!stopAnchoredGroups(unreached, table, ops, state)) return;
    }
  } catch (error) {
    state.failures.record("process table unreadable", error, unreachedGroups(state));
  }
}

/**
 * Stops each unreached group a confirmed-stopped parent anchors, then records which
 * rows this read shows stopped for the NEXT read to rely on. Returns whether another
 * read can still reach a group: one was just stopped, or a group still waits on a
 * parent in a frozen group that no earlier read showed stopped yet.
 */
function stopAnchoredGroups(
  unreached: readonly number[],
  table: readonly ProcessEntry[],
  ops: SweepOps,
  state: SweepState,
): boolean {
  const pending = [...state.live].filter(([group]) => unreached.includes(group));
  const anchored = pending.filter(([, parents]) => [...parents].some((p) => isAnchor(p, state)));
  const waiting = pending.some(([, parents]) =>
    [...parents].some((parent) => state.frozen.has(parent.pgid)),
  );
  for (const row of table) {
    if (row.stopped && state.frozen.has(row.pgid)) state.confirmed.add(row.pid);
  }
  for (const [group] of anchored) stopGroup(group, ops, state);
  return anchored.length > 0 || waiting;
}

/** A parent an earlier read showed stopped in a frozen group, and still stopped now. */
function isAnchor(parent: ProcessEntry, state: SweepState): boolean {
  return parent.stopped && state.frozen.has(parent.pgid) && state.confirmed.has(parent.pid);
}

/** The live groups in the latest read that the sweep has not tried to stop. */
function unreachedGroups(state: SweepState): number[] {
  return [...state.live.keys()].filter(
    (group) => !(state.frozen.has(group) || state.unstoppable.has(group)),
  );
}

/** A group that vanished (`ESRCH`) needs nothing; any other refusal is judged at the end. */
function stopGroup(group: number, ops: SweepOps, state: SweepState): void {
  try {
    ops.stopGroup(group);
    state.stopped.push(group);
    state.frozen.add(group);
  } catch (error) {
    if (errnoCode(error) !== "ESRCH") state.unstoppable.set(group, error);
  }
}
