/**
 * Reaps the process tree of a PTY leader on session teardown.
 * Implements PRD §5.3 and §9.4 (C-LIFE-10): a CLI-spawned helper such as the
 * Claude hook bridge is a descendant of the PTY leader. Because POSIX reparents
 * a surviving descendant to PID 1 the instant its parent exits, a parent-pid
 * walk (`pgrep -P`) cannot find it afterwards — but node-pty starts the leader
 * as its own session/process-group leader, and group membership is inherited
 * and survives reparenting. So we reap by SIGKILLing the leader's process group,
 * which reaches every descendant in one in-process syscall: no subprocess, no
 * PATH lookup, no post-exit reparenting blind spot.
 */

/** Injectable so tests never signal real process groups; production uses `process.kill`. */
export type ProcessGroupKiller = {
  /** SIGKILLs the process group `pgid` (via `kill(-pgid)`); tolerates an empty/dead group. */
  readonly killGroup: (pgid: number) => void;
};

/**
 * Group ids at or below this value are refused: `init`/`launchd` and core system
 * daemons occupy the low pids/pgids, and a real PTY leader is always a freshly
 * spawned high pid. This makes reaping a system group impossible even if a caller
 * passes a bad pgid.
 */
const minReapableGroupId = 100;

/**
 * SIGKILLs the process group led by `leaderPid`, reaping every descendant still
 * in the group — including one already reparented to PID 1. node-pty starts the
 * leader via `setsid()`, so it heads its own session and its pgid equals its pid;
 * that group is always distinct from the host's own group, so this cannot signal
 * the host process. No-ops on a system-range id. An already-dead group (leader and
 * children exited together) is the normal case and its `ESRCH` is swallowed; a
 * real kill failure such as `EPERM` propagates.
 */
export function reapProcessGroup(leaderPid: number, ops: ProcessGroupKiller = activeKiller): void {
  if (!Number.isInteger(leaderPid) || leaderPid < minReapableGroupId) return;
  ops.killGroup(leaderPid);
}

const defaultKiller: ProcessGroupKiller = {
  killGroup(pgid: number): void {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (error) {
      rethrowUnlessGroupGone(error);
    }
  },
};

// The killer used when a caller does not inject one. A test seam so session
// lifecycle tests can observe (and neutralize) the group SIGKILL without a real
// signal, and without every session/terminate call site taking a killer param.
let activeKiller: ProcessGroupKiller = defaultKiller;

export function setGroupKillerForTests(killer: ProcessGroupKiller): void {
  activeKiller = killer;
}

export function resetGroupKillerForTests(): void {
  activeKiller = defaultKiller;
}

/**
 * Swallows the ESRCH raised when the group is already empty (the normal case:
 * the leader and its children exited together) and re-throws any other error —
 * a real failure (e.g. EPERM) that must not be reported as a successful reap.
 * Exported for focused coverage of both branches without an unsafe real signal.
 */
export function rethrowUnlessGroupGone(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
}
