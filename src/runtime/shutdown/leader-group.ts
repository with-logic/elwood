/** Numeric group guards for owned PTY reaping (PRD §5.3, C-LIFE-10). */
import { activeProcessTreeOps, type GroupReapOps } from "./process-tree-ops.ts";

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
export function isReapableGroupId(pgid: number): boolean {
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
export function reapProcessGroup(
  leaderPid: number,
  ops: GroupReapOps = activeProcessTreeOps(),
): void {
  if (!isReapableGroupId(leaderPid)) return;
  ops.killGroup(leaderPid);
}
