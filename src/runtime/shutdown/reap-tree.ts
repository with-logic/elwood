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

import type { SweepFailure } from "./detached-sweep/failures.ts";
import { sweepDetachedGroups } from "./detached-sweep/index.ts";
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
 * Owns a single PTY leader's group reap. A SUCCESSFUL reap MUST happen at most
 * once: `stop()` then a later `teardown()` both want to guarantee the group is
 * gone, but signaling the same numeric pgid twice is unsafe — once the group is
 * empty the kernel may recycle the pid, and a second `kill(-pgid)` would hit an
 * unrelated group. So the latch is set only AFTER the kill succeeds (an already
 * empty group's `ESRCH` is normalized to success by `reapProcessGroup`). A real
 * failure (e.g. EPERM) leaves the latch OPEN and rethrows, so a later teardown
 * call can retry rather than leaving the descendant leak permanently unreaped.
 */
export class SessionReaper {
  private readonly leaderPid: number;
  private readonly ops: ProcessTreeOps;
  private done = false;
  private readonly queue = new SerialReapQueue();
  /** A detached sweep that failed; once the leader is gone it can never be confirmed. */
  private unresolvedSweep: SweepFailure | undefined;

  constructor(leaderPid: number, ops: ProcessTreeOps = activeProcessTreeOps()) {
    this.leaderPid = leaderPid;
    this.ops = ops;
  }

  /**
   * Reap the group once it succeeds; a successful call latches so subsequent
   * calls no-op (no recycled-pgid double-kill). A failed kill does NOT latch and
   * rethrows, keeping the reap retryable on a later lifecycle call.
   */
  reap(): void {
    if (this.done) return;
    reapProcessGroup(this.leaderPid, this.ops);
    this.done = true;
  }

  /**
   * The group reap for an explicit shutdown's retry: it also keeps failing while an
   * earlier detached sweep is unresolved, so a later `stop()`/`kill()`/`teardown()`
   * never reports success for a hook that may still be running. It says nothing about
   * a sweep that never ran: the caller sweeps first, before any SIGKILL it sends to a
   * live leader.
   */
  reapAndThrowOnDetachedSweepFailure(): void {
    this.reap();
    if (this.unresolvedSweep !== undefined) throw this.unresolvedSweep;
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
    if (!isReapableGroupId(this.leaderPid)) return;
    const failure = await this.queue.run(() =>
      sweepDetachedGroups(this.leaderPid, this.ops, leaderExited),
    );
    if (failure === undefined) return;
    this.unresolvedSweep = failure;
    throw failure;
  }
}
