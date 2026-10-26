/**
 * Stops and SIGKILLs every process group a LIVE PTY leader's linked descendants have
 * moved into, before Elwood kills the leader, but Codex's shared daemon, its updater,
 * and what they started (below). Implements PRD §5.3 and §9.4 (C-LIFE-10).
 * Claude and Codex start each hook command with `setsid()`, so a hook in flight at
 * teardown sits in its own session and process group: the leader-group SIGKILL misses
 * it, and once the leader dies the hook is reparented to PID 1 and nothing links it to
 * the session any more. The walk therefore has to happen first. It finds only what is
 * still linked by parent pid (see `detachedDescendantGroups`).
 *
 * A group id read from the table is a snapshot, free for reuse once the group is gone,
 * and a `kill()` that returns has only sent the SIGSTOP. So the sweep acts only on what
 * two consecutive reads show (see `rounds.ts`): a group is sent SIGSTOP once a parent of
 * one of its members is held, read stopped in this read and the one before inside a
 * group the sweep signaled. The walk succeeds only on a read that converges: it shows
 * the leader live, leaves no live group unreached, and holds every live member of every
 * signaled group, the leader's included. A read that shows a signaled group's member
 * running stops that group again. With no hook in flight that takes two reads; each
 * level of nesting adds two more. Then the signaled groups are SIGKILLed deepest first
 * (`kill.ts`). Codex's app-server daemon and its updater loop are shared by every Codex
 * on the same `CODEX_HOME`, the user's own included, so the walk never descends into
 * either: neither one nor anything it started is killed (`shared-daemon.ts`). A group it
 * stopped as its process became one is resumed with SIGCONT, never SIGKILLed, even once
 * the leader's exit left it under PID 1. (A parent that ignores SIGCHLD would have its
 * exited children reaped while stopped; the CLIs and hook shells don't.)
 */

import { errnoCode } from "../../../core/errors.ts";
import { detachedDescendantGroups } from "../process-table.ts";
import { daemonScope } from "../shared-daemon.ts";
import { type SweepFailure, SweepFailures } from "./failures.ts";
import {
  confirmedGone,
  confirmLiveGroups,
  killOrResumeSignaledGroups,
  recordFailedRead,
} from "./kill.ts";
import {
  newSweepState,
  recordUnconfirmed,
  restopEscapedGroups,
  type SweepOps,
  type SweepState,
  stopAnchoredGroups,
  sweepOutcome,
  unheldGroups,
  unreachedGroups,
} from "./rounds.ts";

export type { SweepOps } from "./rounds.ts";

/**
 * The whole sweep's deadline. A hook that started a setsid child of its own takes six
 * reads, and on a loaded host one read can take over half a second (docs/cli-behavior.md).
 */
export const DETACHED_SWEEP_BUDGET_MS = 10_000;

/**
 * Sweeps `leaderPid`'s detached descendant groups and resolves to the unresolved
 * failure, or `undefined` once a read converged and every group it signaled was killed,
 * or resumed as holding Codex's daemon.
 * The leader's own group is left to the group reap. A leader whose exit was observed
 * before the sweep, or whose group refuses its SIGSTOP because it already exited (see
 * `leaderStopFailure`), exited before Elwood signaled it: nothing more is sent and nothing
 * fails. Otherwise `leaderExited` is read after each table read that does not converge;
 * a read that converges ends the walk before that check. Once the leader has exited its
 * pid may be reused, so the sweep stops no further group and never signals the leader's
 * group again, though it still SIGKILLs the groups it already signaled (resuming any
 * that hold Codex's daemon). These are
 * failures: a leader's group that refuses its stop, so no descendant group is signaled;
 * an unreadable table; the deadline passing, or the leader exiting, before a read
 * converged; a live group that could not be stopped or killed; and a group spared for
 * Codex's daemon that could not be resumed (a SIGCONT refused but for its being gone).
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
  try {
    ops.stopGroup(leaderPid);
  } catch (error) {
    return leaderStopFailure(error, leaderPid, ops, deadline, state);
  }
  state.signaledGroupIds.add(leaderPid);
  state.unheld = [leaderPid];
  await stopDescendantGroups(leaderPid, ops, leaderExited, deadline, state);
  await killOrResumeSignaledGroups(ops, state, deadline);
  return sweepOutcome(state);
}

/**
 * Reads the table round by round until `deadline`, recording into `state`: each read
 * refreshes `live` and `unheld`, stops again each signaled group with a running member,
 * then stops the unreached groups a held parent anchors. It returns without a failure
 * only on a read that converges, so nothing the sweep signaled could have started a
 * process that read missed. It records a failure against every group not yet confirmed
 * stopped, and returns, when the table cannot be read, or when the deadline passes or
 * the leader's exit is observed first.
 */
async function stopDescendantGroups(
  leaderPid: number,
  ops: SweepOps,
  leaderExited: () => boolean,
  deadline: number,
  state: SweepState,
): Promise<void> {
  // Each group the walk stops is a root too: its exit can leave one under PID 1.
  const scope = daemonScope(state.signaledGroupIds);
  try {
    while (true) {
      const remainingMs = Math.ceil(deadline - performance.now());
      if (remainingMs <= 0)
        return recordUnconfirmed(state, "process groups not confirmed stopped by the deadline");
      const table = await ops.listProcesses(remainingMs, scope);
      state.latest = table;
      state.live = detachedDescendantGroups(table, { leaderPid, hostPid: process.pid });
      state.unheld = unheldGroups(table, state, leaderPid);
      if (unreachedGroups(state).length === 0 && state.unheld.length === 0) return;
      if (leaderExited())
        return recordUnconfirmed(
          state,
          "the leader exited before every group was confirmed stopped",
        );
      restopEscapedGroups(table, ops, state);
      stopAnchoredGroups(table, ops, state);
    }
  } catch (error) {
    recordUnconfirmed(state, "process table unreadable", error);
  }
}

/**
 * Judges a refused SIGSTOP of the leader's group. The leader had already exited, so the
 * sweep has nothing to do, when the group is gone (`ESRCH`), or when macOS refused it
 * with `EPERM` because only unreaped zombies remain, which a fresh read must then show.
 * Otherwise the leader could not be stopped, so no descendant group is signaled.
 */
async function leaderStopFailure(
  error: unknown,
  leaderPid: number,
  ops: SweepOps,
  deadline: number,
  state: SweepState,
): Promise<SweepFailure | undefined> {
  const code = errnoCode(error);
  if (code === "ESRCH") return undefined;
  const confirmation = code === "EPERM" ? await confirmLiveGroups(ops, deadline) : undefined;
  if (confirmation !== undefined && confirmedGone(confirmation, leaderPid)) return undefined;
  state.failures.record("could not stop the leader's group", error, [leaderPid]);
  if (confirmation !== undefined) recordFailedRead(confirmation, state, [leaderPid]);
  return state.failures.result();
}
