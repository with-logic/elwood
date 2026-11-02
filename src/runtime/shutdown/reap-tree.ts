/**
 * Reaps the process tree of a PTY leader on session teardown, but Codex's shared
 * app-server daemon, its updater, and what they started (`shared-daemon.ts`).
 * Implements PRD §5.3 and §9.4 (C-LIFE-10): a CLI-spawned helper such as the
 * Claude hook bridge is a descendant of the PTY leader. Because POSIX reparents
 * a surviving descendant to PID 1 the instant its parent exits, a parent-pid
 * walk (`pgrep -P`) cannot find it afterwards — but node-pty starts the leader
 * as its own session/process-group leader, and group membership is inherited
 * and survives reparenting. So we reap by SIGKILLing the leader's process group,
 * which reaches every descendant still IN that group in one in-process syscall: no
 * subprocess, no PATH lookup, no post-exit reparenting blind spot.
 *
 * A descendant that started its own group is outside it: Claude and Codex start every
 * hook with `setsid()` (docs/cli-behavior.md, "Hook and MCP process groups").
 * `sweepDetached` finds those groups by parent pid and kills them, all but the daemon's
 * and its updater's, which other Codex sessions share, so it has to run
 * while that link still exists: before the live leader is SIGKILLed (see
 * `sweepDetachedGroups` in `detached-sweep/index.ts`).
 */

import { toError } from "../../core/errors.ts";
import { type BackgroundReap, reapInBackground } from "./detached-sweep/background.ts";
import type { SweepFailure } from "./detached-sweep/failures.ts";
import { DETACHED_SWEEP_BUDGET_MS, sweepDetachedGroups } from "./detached-sweep/index.ts";
import { DescendantRecord } from "./detached-sweep/record.ts";
import { type SurvivorWatch, watchSurvivors } from "./detached-sweep/survivor-watch.ts";
import { reapRecordedSurvivors } from "./detached-sweep/survivors.ts";
import { isReapableGroupId, reapProcessGroup } from "./leader-group.ts";
import { activeProcessTreeOps, type ProcessTreeOps } from "./process-tree-ops.ts";

import { SerialReapQueue } from "./reap-queue.ts";

export { reapProcessGroup } from "./leader-group.ts";

export {
  osProcessTreeOps,
  type ProcessTreeOps,
  quietProcessTree,
  resetProcessTreeOpsForTests,
  rethrowUnlessGroupGone,
  setProcessTreeOpsForTests,
} from "./process-tree-ops.ts";

/**
 * Owns a single PTY leader's group reap. A SUCCESSFUL reap MUST happen at most once:
 * `stop()` then a later `teardown()` both want the group gone, but signaling the same
 * numeric pgid twice is unsafe — once the group is empty the kernel may recycle the
 * pid, and a second `kill(-pgid)` would hit an unrelated group. So the latch is set
 * only AFTER the kill succeeds (an empty group's `ESRCH` counts as success, see
 * `reapProcessGroup`); a real failure (e.g. EPERM) leaves it OPEN for a later retry.
 */
export class SessionReaper {
  private readonly leaderPid: number;
  private readonly ops: ProcessTreeOps;
  private done = false;
  private leaderSignalFailure: Error | undefined;
  /** One session owns at most one foreground or background descendant reap. */
  private readonly reaping = new SerialReapQueue();
  /** Retained failure: only the leader-rooted walk is never rerun; recorded survivors retry. */
  private unresolvedSweep: SweepFailure | undefined;
  /** Each failure's recorded processes, reaped in the background (`background.ts`). */
  private readonly reapsInBackground: BackgroundReap[] = [];

  constructor(leaderPid: number, ops: ProcessTreeOps = activeProcessTreeOps()) {
    this.leaderPid = leaderPid;
    this.ops = {
      ...ops,
      stopGroup: (group) => {
        if (group === leaderPid) this.assertLeaderSignalAuthorized();
        ops.stopGroup(group);
      },
      killGroup: (group) => {
        if (group === leaderPid) this.assertLeaderSignalAuthorized();
        ops.killGroup(group);
      },
    };
  }

  /**
   * Reap the group once it succeeds; a successful call latches so subsequent
   * calls no-op (no recycled-pgid double-kill). A failed kill does NOT latch and
   * rethrows, keeping the reap retryable on a later lifecycle call.
   */
  assertLeaderSignalAuthorized(): void {
    if (this.leaderSignalFailure) throw this.leaderSignalFailure;
  }

  reap(): void {
    this.assertLeaderSignalAuthorized();
    if (this.done) return;
    reapProcessGroup(this.leaderPid, this.ops);
    this.done = true;
  }

  /**
   * The group reap for an explicit shutdown's retry: it keeps failing while an earlier
   * sweep or survivor reap is unresolved, so no later call reports success for a hook
   * that may still run, until a read shows no recorded non-daemon survivor remains and
   * every failed daemon resume has succeeded or become unnecessary.
   * The caller sweeps before any SIGKILL to a live leader. Explicit retries first await
   * confirmDetachedSweepFailure when its automatic recovery window expired.
   */
  reapAndThrowOnDetachedSweepFailure(): void {
    this.reap();
    const resolved = this.reapsInBackground.every((reap) => reap.resolved());
    if (resolved) this.unresolvedSweep = undefined;
    if (this.unresolvedSweep !== undefined) throw this.unresolvedSweep;
  }

  /** Fresh serialized confirmation only after a retained recovery's automatic window expired. */
  confirmDetachedSweepFailure(): Promise<void> | undefined {
    const confirmations = this.reapsInBackground
      .map((reap) => reap.confirm())
      .filter((pending) => pending !== undefined);
    if (confirmations.length === 0) return undefined;
    return Promise.all(confirmations).then(() => undefined);
  }

  /**
   * Kill the process groups the leader's descendants moved into. Valid only while
   * the leader is alive — afterwards its detached descendants are reparented to
   * PID 1 and cannot be found — so it runs just before the leader is SIGKILLed, with
   * `leaderExited` reporting whether the caller has seen the leader exit. A failure,
   * including a leader exit that left a found group unreached, is kept for
   * `reapAndThrowOnDetachedSweepFailure`, then thrown. Refuses the same misrouted ids
   * as the group reap.
   */
  async sweepDetached(leaderExited: () => boolean): Promise<void> {
    this.assertLeaderSignalAuthorized();
    if (!isReapableGroupId(this.leaderPid)) return;
    const record = new DescendantRecord();
    const budget = DETACHED_SWEEP_BUDGET_MS;
    this.retainFailureAndStartRecovery(
      await this.reaping.run(() =>
        sweepDetachedGroups(this.leaderPid, this.ops, leaderExited, budget, record),
      ),
      record,
    );
  }

  /** A graceful stop's watch for survivors (`survivors.ts`); a failure is kept as a sweep's. */
  watchSurvivors(leaderExited: () => boolean): SurvivorWatch {
    const leaderPid = isReapableGroupId(this.leaderPid) ? this.leaderPid : undefined;
    const retainFailureAndStartRecovery = (
      failure: SweepFailure | undefined,
      record: DescendantRecord,
    ) => this.retainFailureAndStartRecovery(failure, record);
    return watchSurvivors(
      leaderPid,
      this.ops,
      leaderExited,
      retainFailureAndStartRecovery,
      (record, ops) => this.reaping.run(() => reapRecordedSurvivors(record, ops)),
      (attempt) => this.reaping.run(attempt),
      (error) => {
        this.leaderSignalFailure ??= toError(error);
      },
    );
  }

  /** Keeps `failure`, and reaps the processes `record` holds in the background. */
  private retainFailureAndStartRecovery(
    failure: SweepFailure | undefined,
    record: DescendantRecord,
  ): void {
    if (failure === undefined) return;
    this.unresolvedSweep ??= failure;
    const unreferenced = this.ops.listProcessesUnreferenced ?? this.ops.listProcesses;
    this.reapsInBackground.push(
      reapInBackground(
        record,
        { ...this.ops, listProcesses: unreferenced },
        (attempt) => this.reaping.run(attempt),
        this.ops,
      ),
    );
    throw failure;
  }
}
