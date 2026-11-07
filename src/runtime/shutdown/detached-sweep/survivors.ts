/**
 * Verifies and reaps recorded original leader-group members and detached helpers
 * (PRD §5.3/§9.4, C-LIFE-10), while the leader lives or after exit reparents helpers.
 * A recorded PID and start time permit SIGSTOP; only a fresh original stopped member
 * in the same group authorizes SIGKILL. The existing sweep rounds handle children
 * forked during STOP and preserve Codex's shared daemon (`kill.ts`). Unattributable
 * live members of the original group retain failure without authorizing any signal.
 * Unconfirmed holds require fresh original identity for restoration; otherwise only
 * owned restoration debt remains eligible for a later verified attempt.
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
import { survivorAndDescendantGroups } from "./survivor-groups.ts";

/** A fresh pre-stop read, reusable only as the first survivor pass observation. */
type SurvivorSeed = {
  readonly table: readonly ProcessEntry[];
  readonly readStartedAtEpochMs: number;
};

/**
 * Stops and SIGKILLs groups holding `record`'s original processes that are still alive, and
 * any group they anchor, within the sweep's budget. Resolves to the unresolved failure,
 * or `undefined` once a read converged and every signaled group was killed, or resumed as
 * holding Codex's daemon. A record that does not know the leader's tree fails, and one
 * that knows it empty reads nothing.
 */
export async function reapRecordedSurvivors(
  record: DescendantRecord,
  ops: SweepOps,
  budgetMs: number = DETACHED_SWEEP_BUDGET_MS,
  initial?: SurvivorSeed,
): Promise<SweepFailure | undefined> {
  const state = newSweepState(new SweepFailures());
  record.includeReadFailure(state.failures);
  if (!record.known) {
    state.failures.record("no read showed the leader's tree", undefined, []);
    return state.failures.result();
  }
  if (record.hasUnknownResume)
    state.failures.record("a stopped group has unresolved restoration", undefined, []);
  if (record.pids.length === 0) return state.failures.result();
  const deadline = performance.now() + budgetMs;
  const anchors = new SurvivorAnchors(state, record, ops);
  await stopSurvivorGroups(record, anchors.stoppingOps(), deadline, state, anchors, initial);
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
  initial: SurvivorSeed | undefined,
): Promise<void> {
  // Codex's daemon is marked under two kinds of root. A recorded pid: a recorded process
  // may have `exec`'d the daemon since it was recorded. A stopped group: its parent's exit
  // can leave the daemon in it under PID 1, under no recorded pid.
  const scopeRoots = new Set(record.pids);
  const scope = daemonScope(scopeRoots);
  let firstRead = initial;
  try {
    while (true) {
      for (const group of state.signaledGroupIds) scopeRoots.add(group);
      const remainingMs = Math.ceil(deadline - performance.now());
      if (remainingMs <= 0)
        return recordUnconfirmed(state, "process groups not confirmed stopped by the deadline");
      const readStartedAtEpochMs = firstRead?.readStartedAtEpochMs ?? Date.now();
      const table = firstRead?.table ?? (await ops.listProcesses(remainingMs, scope));
      firstRead = undefined;
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
      if (survivors.length === 0 && state.signaledGroupIds.size === 0) {
        recordAmbiguousGroups(blocked, state);
        state.live = new Map();
        return;
      }
      const { roots, groups: discovered } = survivorAndDescendantGroups(
        survivors,
        table,
        process.pid,
      );
      // Retain owned children before another group's failed anchor can lose their parent link.
      record.observeGroups(table, discovered, readStartedAtEpochMs);
      anchors.afterRead(table);
      const unsafe = record.unsafeSurvivorGroups(table);
      recordAmbiguousGroups(unsafe, state);
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

/** Preserve unknown original-group ownership even when no survivor remains to traverse. */
function recordAmbiguousGroups(groups: ReadonlySet<number>, state: SweepState): void {
  if (groups.size > 0)
    state.failures.record("a survivor group has an ambiguous identity", undefined, [...groups]);
}
