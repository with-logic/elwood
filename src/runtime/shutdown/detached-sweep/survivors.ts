/**
 * Reaps the recorded detached descendants that outlived a PTY leader's graceful exit
 * (PRD §5.3 and §9.4, C-LIFE-10), with the detached sweep's rounds and kill pass. With
 * the leader gone no parent pid links them to the session, so a group is first stopped
 * because a read shows a recorded process in it: same pid, same start time (`record.ts`).
 * From there the sweep's rules hold (`index.ts`), less the live leader: a held process
 * anchors the groups it started, a group read with a member running is stopped again,
 * and once a read converges the signaled groups are SIGKILLed deepest first, but one
 * holding Codex's daemon, which is resumed (`kill.ts`). A group stops counting as a
 * survivor once no recorded process is alive in it. Each post-stop read checks the
 * original member identities; an unconfirmed or mismatched group is resumed and
 * never passed to the kill phase (`survivor-anchors.ts`).
 */

import { detachedDescendantGroups, type ProcessEntry } from "../process-table.ts";
import { daemonScope } from "../shared-daemon.ts";
import { DETACHED_SWEEP_BUDGET_MS } from "./budget.ts";
import { type SweepFailure, SweepFailures } from "./failures.ts";
import { killOrResumeSignaledGroups } from "./kill.ts";
import { type DescendantRecord, watchDescendants } from "./record.ts";
import {
  newSweepState,
  recordUnconfirmed,
  restopEscapedGroups,
  type SweepOps,
  type SweepState,
  stopAnchoredGroups,
  stopGroup,
  sweepOutcome,
  unheldGroups,
  unreachedGroups,
} from "./rounds.ts";
import { SurvivorAnchors } from "./survivor-anchors.ts";

/** A graceful stop's watch for survivors, from the first recording read to the reap. */
export type SurvivorWatch = {
  /** Whether the read before SIGTERM showed the leader gone; false for a failed read. */
  readonly firstRead: Promise<boolean>;
  /**
   * Stops recording, then, if `leaderExited` reports the exit, reaps the recorded
   * processes still alive and hands the outcome, a failure or `undefined`, to `keep`
   * with the record. A failed termination without a confirmed exit retains a failure
   * instead of discarding that record.
   */
  readonly finish: (failedTermination?: boolean) => Promise<void>;
};

/**
 * Records `leaderPid`'s detached descendants (`watchDescendants`) until `finish`. Records
 * nothing for an `undefined` leader, one whose id the group reap refuses.
 */
export function watchSurvivors(
  leaderPid: number | undefined,
  ops: SweepOps,
  leaderExited: () => boolean,
  keep: (failure: SweepFailure | undefined, record: DescendantRecord) => void,
  reap: typeof reapRecordedSurvivors = reapRecordedSurvivors,
): SurvivorWatch {
  if (leaderPid === undefined)
    return { firstRead: Promise.resolve(false), finish: () => Promise.resolve() };
  const watch = watchDescendants(leaderPid, ops, leaderExited);
  return {
    firstRead: watch.firstRead,
    finish: async (failedTermination = false) => {
      const record = await watch.finish();
      if (leaderExited()) keep(await reap(record, ops), record);
      else if (failedTermination) {
        const failures = new SweepFailures();
        failures.record("the leader's exit was not confirmed", undefined, []);
        keep(failures.result(), record);
      }
    },
  };
}

/**
 * Stops and SIGKILLs the groups holding `record`'s processes that are still alive, and
 * any group they anchor, within the sweep's budget. Resolves to the unresolved failure,
 * or `undefined` once a read converged and every signaled group was killed, or resumed as
 * holding Codex's daemon. A record that does not know the leader's tree fails, and one
 * that knows it empty reads nothing.
 */
export async function reapRecordedSurvivors(
  record: DescendantRecord,
  ops: SweepOps,
  budgetMs: number = DETACHED_SWEEP_BUDGET_MS,
  firstTable?: readonly ProcessEntry[],
): Promise<SweepFailure | undefined> {
  const state = newSweepState(new SweepFailures());
  if (!record.known) {
    state.failures.record("no read showed the leader's tree", undefined, []);
    return state.failures.result();
  }
  if (record.pids.length === 0) return undefined;
  const deadline = performance.now() + budgetMs;
  const anchors = new SurvivorAnchors(state, record, ops);
  await stopSurvivorGroups(record, anchors.stoppingOps(), deadline, state, firstTable, anchors);
  anchors.restoreUnconfirmed();
  await killOrResumeSignaledGroups(ops, state, deadline, record);
  return sweepOutcome(state);
}

/** Reads round by round until a read converges, as `stopDescendantGroups` does. */
async function stopSurvivorGroups(
  record: DescendantRecord,
  ops: SweepOps,
  deadline: number,
  state: SweepState,
  firstTable: readonly ProcessEntry[] | undefined,
  anchors: SurvivorAnchors,
): Promise<void> {
  // Codex's daemon is marked under two kinds of root. A recorded pid: a recorded process
  // may have `exec`'d the daemon since it was recorded. A stopped group: its parent's exit
  // can leave the daemon in it under PID 1, under no recorded pid.
  const scopeRoots = new Set(record.pids);
  const scope = daemonScope(scopeRoots);
  let initial = firstTable;
  try {
    while (true) {
      for (const group of state.signaledGroupIds) scopeRoots.add(group);
      const remainingMs = Math.ceil(deadline - performance.now());
      if (remainingMs <= 0)
        return recordUnconfirmed(state, "process groups not confirmed stopped by the deadline");
      const table = initial ?? (await ops.listProcesses(remainingMs, scope));
      initial = undefined;
      state.latest = table;
      if (!anchors.afterRead(table)) return;
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
    recordUnconfirmed(state, "process table unreadable", error);
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
