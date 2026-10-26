/**
 * Reaps the recorded detached descendants that outlived a PTY leader's graceful exit
 * (PRD §5.3 and §9.4, C-LIFE-10), with the detached sweep's rounds and kill pass. With
 * the leader gone no parent pid links them to the session, so a group is first stopped
 * because a read shows a recorded process in it: same pid, same start time (`record.ts`).
 * From there the sweep's rules hold (`index.ts`), less the live leader: a held process
 * anchors the groups it started, a group read with a member running is stopped again,
 * and once a read converges the signaled groups are SIGKILLed deepest first, but one
 * holding Codex's daemon, which is resumed (`kill.ts`). A group stops counting as a
 * survivor once no recorded process is alive in it. The one exposure the identity leaves
 * is a recorded process that exits between the read that shows it and the SIGSTOP, its
 * group id reused within that moment; anchors rule that out only for a live leader.
 */

import { detachedDescendantGroups, type ProcessEntry } from "../process-table.ts";
import { daemonScope } from "../shared-daemon.ts";
import { type FailureReason, type SweepFailure, SweepFailures } from "./failures.ts";
import { DETACHED_SWEEP_BUDGET_MS } from "./index.ts";
import { killSignaledGroups } from "./kill.ts";
import { type DescendantRecord, watchDescendants } from "./record.ts";
import {
  newSweepState,
  restopEscapedGroups,
  type SweepOps,
  type SweepState,
  stopAnchoredGroups,
  stopGroup,
  unheldGroups,
  unreachedGroups,
} from "./rounds.ts";

/** A graceful stop's watch for survivors, from the first recording read to the reap. */
export type SurvivorWatch = {
  /** Settles once the read before the SIGTERM has finished, whether or not it succeeded. */
  readonly firstRead: Promise<void>;
  /**
   * Stops recording, then, once the leader is gone, reaps the recorded processes still
   * alive and hands the outcome, a failure or `undefined`, to `keep`.
   */
  readonly finish: (leaderGone: boolean) => Promise<void>;
};

/**
 * Records `leaderPid`'s detached descendants (`watchDescendants`) until `finish`. Records
 * nothing for an `undefined` leader, one whose id the group reap refuses.
 */
export function watchSurvivors(
  leaderPid: number | undefined,
  ops: SweepOps,
  leaderExited: () => boolean,
  keep: (failure: SweepFailure | undefined) => void,
): SurvivorWatch {
  if (leaderPid === undefined)
    return { firstRead: Promise.resolve(), finish: () => Promise.resolve() };
  const watch = watchDescendants(leaderPid, ops, leaderExited);
  return {
    firstRead: watch.firstRead,
    finish: async (leaderGone) => {
      const record = await watch.finish();
      if (leaderGone) keep(await reapRecordedSurvivors(record, ops));
    },
  };
}

/**
 * Stops and SIGKILLs the groups holding `record`'s processes that are still alive, and
 * any group they anchor, within the sweep's budget. Resolves to the unresolved failure,
 * or `undefined` once a read converged and every signaled group was killed, or resumed as
 * holding Codex's daemon. A record no read filled (every read failed) fails.
 */
export async function reapRecordedSurvivors(
  record: DescendantRecord,
  ops: SweepOps,
  budgetMs: number = DETACHED_SWEEP_BUDGET_MS,
): Promise<SweepFailure | undefined> {
  const state = newSweepState(new SweepFailures());
  if (!record.observed) {
    state.failures.record("process table unreadable", undefined, []);
    return state.failures.result();
  }
  const deadline = performance.now() + budgetMs;
  await stopSurvivorGroups(record, ops, deadline, state);
  await killSignaledGroups(ops, state, deadline);
  for (const [group, error] of state.unstoppable) {
    if (state.live.has(group))
      state.failures.record("could not stop a live descendant group", error, [group]);
  }
  return state.failures.result();
}

/** Reads round by round until a read converges, as `stopDescendantGroups` does. */
async function stopSurvivorGroups(
  record: DescendantRecord,
  ops: SweepOps,
  deadline: number,
  state: SweepState,
): Promise<void> {
  // Marks Codex's daemon among them, as a recorded process may have `exec`'d it since, and
  // in each group stopped, which its parent's exit could leave under PID 1.
  const scopeRoots = new Set(record.pids);
  const scope = daemonScope(scopeRoots);
  try {
    while (true) {
      for (const group of state.signaledGroupIds) scopeRoots.add(group);
      const remainingMs = Math.ceil(deadline - performance.now());
      if (remainingMs <= 0)
        return unconfirmed(state, "process groups not confirmed stopped by the deadline");
      const table = await ops.listProcesses(remainingMs, scope);
      state.latest = table;
      const roots = survivorGroups(record.survivors(table), table);
      state.live = liveGroups(table, roots);
      state.unheld = unheldGroups(table, state);
      if (unreachedGroups(state).length === 0 && state.unheld.length === 0) return;
      restopEscapedGroups(table, ops, state);
      stopAnchoredGroups(table, ops, state);
      for (const group of unreachedGroups(state)) {
        if (roots.has(group)) stopGroup(group, ops, state);
      }
    }
  } catch (error) {
    unconfirmed(state, "process table unreadable", error);
  }
}

/** The groups of `survivors`, never the host's or an id `kill(-pgid)` would misroute. */
function survivorGroups(
  survivors: readonly ProcessEntry[],
  table: readonly ProcessEntry[],
): ReadonlySet<number> {
  const host = table.find((row) => row.pid === process.pid)?.pgid;
  return new Set(survivors.map((row) => row.pgid).filter((pgid) => pgid > 1 && pgid !== host));
}

/** The survivor groups, then every group a member of one anchors, with the parents' rows. */
function liveGroups(
  table: readonly ProcessEntry[],
  roots: ReadonlySet<number>,
): ReadonlyMap<number, ReadonlySet<ProcessEntry>> {
  const live = new Map<number, Set<ProcessEntry>>([...roots].map((group) => [group, new Set()]));
  for (const member of table) {
    if (member.zombie || !roots.has(member.pgid)) continue;
    const found = detachedDescendantGroups(table, { leaderPid: member.pid, hostPid: process.pid });
    for (const [group, parents] of found) {
      const known = live.get(group) ?? new Set<ProcessEntry>();
      for (const parent of parents) known.add(parent);
      live.set(group, known);
    }
  }
  return live;
}

function unconfirmed(state: SweepState, reason: FailureReason, error?: unknown): void {
  state.failures.record(reason, error, [...unreachedGroups(state), ...state.unheld]);
}
