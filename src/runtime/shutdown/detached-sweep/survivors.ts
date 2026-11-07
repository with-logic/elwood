/**
 * Reaps the recorded detached descendants that outlived a PTY leader's graceful exit
 * (PRD §5.3 and §9.4, C-LIFE-10), with the detached sweep's rounds and kill pass. With
 * the leader gone no parent pid links them to the session, so a group is first stopped
 * because a read shows a recorded process in it: same pid, same start time (`record.ts`).
 * From there the sweep's rules hold (`index.ts`), less the live leader: a held process
 * anchors the groups it started, a group read with a member running is stopped again,
 * and once a read converges the signaled groups are SIGKILLed deepest first, but one
 * holding Codex's daemon, which is resumed (`kill.ts`). A fresh post-stop read must
 * confirm an original stopped member before the kill pass. Unconfirmed holds fail;
 * restoration requires a fresh original identity, otherwise only owned debt is retained.
 * This private foundation has no production lifecycle caller yet.
 */

import { errnoCode } from "../../../core/errors.ts";
import type { ProcessEntry } from "../process-table.ts";
import { daemonScope } from "../shared-daemon.ts";
import { type SweepFailure, SweepFailures } from "./failures.ts";
import { DETACHED_SWEEP_BUDGET_MS } from "./index.ts";
import { killOrResumeSignaledGroups } from "./kill.ts";
import type { DescendantRecord } from "./record.ts";
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
import { survivorDescendantGroups } from "./survivor-groups.ts";

import { watchDescendants } from "./watch-descendants.ts";

/** A graceful stop's watch for survivors, from the first recording read to the reap. */
export type SurvivorWatch = {
  /** Settles once the read before the SIGTERM has finished, whether or not it succeeded. */
  readonly firstRead: Promise<void>;
  /**
   * Stops recording, then, if `leaderExited` reports the exit, reaps the recorded
   * processes still alive and hands the outcome, a failure or `undefined`, to `keep`.
   */
  readonly finish: () => Promise<void>;
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
    finish: async () => {
      const record = await watch.finish();
      if (leaderExited()) keep(await reapRecordedSurvivors(record, ops));
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
): Promise<SweepFailure | undefined> {
  const state = newSweepState(new SweepFailures());
  if (!record.known) {
    state.failures.record("no read showed the leader's tree", undefined, []);
    return state.failures.result();
  }
  if (record.hasUnknownResume)
    state.failures.record("a stopped group has unresolved restoration", undefined, []);
  if (record.pids.length === 0) return state.failures.result();
  const deadline = performance.now() + budgetMs;
  const anchors = new SurvivorAnchors(state, record, ops);
  await stopSurvivorGroups(record, anchors.stoppingOps(), deadline, state, anchors);
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
  anchors: SurvivorAnchors,
): Promise<void> {
  // Codex's daemon is marked under two kinds of root. A recorded pid: a recorded process
  // may have `exec`'d the daemon since it was recorded. A stopped group: its parent's exit
  // can leave the daemon in it under PID 1, under no recorded pid.
  const scopeRoots = new Set(record.pids);
  const scope = daemonScope(scopeRoots);
  try {
    while (true) {
      for (const group of state.signaledGroupIds) scopeRoots.add(group);
      const remainingMs = Math.ceil(deadline - performance.now());
      if (remainingMs <= 0)
        return recordUnconfirmed(state, "process groups not confirmed stopped by the deadline");
      const readStartedAtEpochMs = Date.now();
      const table = await ops.listProcesses(remainingMs, scope);
      state.latest = table;
      record.resumes.retry(table, {
        continueGroup: (group) => {
          try {
            ops.continueGroup(group);
          } catch (error) {
            if (errnoCode(error) !== "ESRCH")
              state.failures.record("a stopped group has unresolved restoration", error, [group]);
            throw error;
          }
        },
      });
      const blocked = record.unsafeSurvivorGroups(table);
      const survivors = record.survivors(table).filter((row) => !blocked.has(row.pgid));
      const roots = survivorGroups(survivors, table);
      const discovered = survivorDescendantGroups(survivors, table);
      // Retain owned children before another group's failed anchor can lose their parent link.
      record.observeGroups(table, discovered, readStartedAtEpochMs);
      anchors.afterRead(table);
      const unsafe = record.unsafeSurvivorGroups(table);
      if (unsafe.size > 0)
        state.failures.record("a survivor group has an ambiguous identity", undefined, [...unsafe]);
      state.live = new Map(
        [...discovered].filter(([group]) => !(unsafe.has(group) || anchors.rejected.has(group))),
      );
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
