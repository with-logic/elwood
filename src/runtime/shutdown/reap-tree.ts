/**
 * Reaps the process tree of a PTY leader on session teardown.
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
 * `sweepDetached` finds those groups by parent pid and kills them, so it has to run
 * while that link still exists: before the live leader is SIGKILLed (see
 * `sweepDetachedGroups` in `detached-sweep/index.ts`).
 */

import { errnoCode } from "../../core/errors.ts";
import type { SweepFailure } from "./detached-sweep/failures.ts";
import { type SweepOps, sweepDetachedGroups } from "./detached-sweep/index.ts";
import { listProcessTableShared } from "./process-table.ts";

/**
 * The process-tree operations teardown performs, injectable so tests never signal real
 * processes: the group reap's SIGKILL, and the detached sweep's SIGSTOP, SIGKILL, and
 * table read.
 */
export type ProcessTreeOps = SweepOps;

/** The part of the process-tree ops the group reap uses. */
type GroupReapOps = Pick<ProcessTreeOps, "killGroup">;

/**
 * A pgid is reapable when it identifies the KNOWN-OWNED node-pty leader's group
 * rather than a system group or the host itself. Ownership is NOT inferred from a
 * numeric floor — that is an allocation detail, and after PID-space wrap or inside
 * a constrained namespace a legitimate leader can be low (a prior arbitrary `< 100`
 * floor silently no-op'd such leaders and leaked their descendants). We instead
 * accept every valid child pid while refusing the two ids a group SIGKILL must
 * never touch:
 *   - `pgid <= 1` — pid 0 means "our own group" to `kill(2)`, and pid 1 is
 *     `init`/`launchd`; a fake pid 1 in tests once reaped a developer's real apps.
 *   - the host's OWN pid — node-pty gives the leader a fresh session via `setsid()`
 *     so its pgid can never legitimately equal ours, but if a bad pgid ever did we
 *     must not signal `-process.pid` and kill ourselves.
 */
function isReapableGroupId(pgid: number): boolean {
  return Number.isInteger(pgid) && pgid > 1 && pgid !== process.pid;
}

/**
 * SIGKILLs the process group led by `leaderPid`, reaping every descendant still
 * in the group — including one already reparented to PID 1. node-pty starts the
 * leader via `setsid()`, so it heads its own session and its pgid equals its pid;
 * that group is always distinct from the host's own group, so this cannot signal
 * the host process. Refuses only pids the kernel would misroute (see
 * `isReapableGroupId`), never an arbitrary numeric floor. An already-dead group
 * (leader and children exited together) is the normal case and its `ESRCH` is
 * swallowed; a real kill failure such as `EPERM` propagates.
 */
export function reapProcessGroup(leaderPid: number, ops: GroupReapOps = activeOps): void {
  if (!isReapableGroupId(leaderPid)) return;
  ops.killGroup(leaderPid);
}

// Production uses `process.kill` and `/bin/ps`. One seam covers the group reap AND the
// detached sweep, so a test that fakes the kill can never leave a real sweep live.
const defaultOps: ProcessTreeOps = {
  killGroup(pgid: number): void {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (error) {
      rethrowUnlessGroupGone(error);
    }
  },
  stopGroup(pgid: number): void {
    process.kill(-pgid, "SIGSTOP");
  },
  listProcesses: listProcessTableShared,
};

// The ops used when a caller does not inject them. A test seam so session lifecycle
// tests can observe (and neutralize) the group SIGKILL without a real signal, and
// without every session/terminate call site taking an ops param.
let activeOps: ProcessTreeOps = defaultOps;

/**
 * Replaces the process-tree ops. Ops a test leaves out become inert, never the real
 * ones, so faking only the kill cannot leave a real sweep live (see `quietProcessTree`).
 */
export function setProcessTreeOpsForTests(ops: GroupReapOps & Partial<ProcessTreeOps>): void {
  activeOps = { ...quietProcessTree(), ...ops };
}

/**
 * Inert sweep ops for tests: a process tree holding only the group leaders it was asked
 * to stop, each read as stopped with nothing under it. A sweep driven by them signals
 * no real process, finds no descendant, and converges on its second read.
 */
export function quietProcessTree(): Pick<ProcessTreeOps, "stopGroup" | "listProcesses"> {
  const stopped = new Set<number>();
  return {
    stopGroup: (pgid) => void stopped.add(pgid),
    listProcesses: () =>
      Promise.resolve(
        [...stopped].map((pgid) => ({ pid: pgid, ppid: 1, pgid, zombie: false, stopped: true })),
      ),
  };
}

export function resetProcessTreeOpsForTests(): void {
  activeOps = defaultOps;
}

/**
 * Swallows the ESRCH raised when the group is already empty (the normal case:
 * the leader and its children exited together) and re-throws any other error —
 * a real failure (e.g. EPERM) that must not be reported as a successful reap.
 * Reads the errno through `errnoCode`, which narrows object-ness first, so a
 * thrown `null`/non-Error is preserved and rethrown rather than triggering a
 * secondary TypeError while inspecting it (C-ERR-01). Exported for focused
 * coverage of both branches without an unsafe real signal.
 */
export function rethrowUnlessGroupGone(error: unknown): void {
  if (errnoCode(error) !== "ESRCH") throw error;
}

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
  /** A detached sweep that failed; once the leader is gone it can never be confirmed. */
  private unresolvedSweep: SweepFailure | undefined;

  constructor(leaderPid: number, ops: ProcessTreeOps = activeOps) {
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
    const failure = await sweepDetachedGroups(this.leaderPid, this.ops, leaderExited);
    if (failure === undefined) return;
    this.unresolvedSweep = failure;
    throw failure;
  }
}
