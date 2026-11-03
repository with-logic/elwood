/**
 * System process-group operations and the shared inert test seam.
 * Implements PRD §5.3 and §9.4 (C-LIFE-10).
 */

import { errnoCode } from "../../core/errors.ts";
import type { SweepOps } from "./detached-sweep/index.ts";
import { UNREAD } from "./process-table.ts";
import { listProcessTableMarkingDaemon } from "./shared-daemon.ts";

/**
 * The process-tree operations teardown performs, injectable so tests never signal real
 * processes: the group reap's SIGKILL, and the detached sweep's SIGSTOP, SIGKILL, the
 * SIGCONT that resumes a group holding Codex's daemon, and table read.
 */
export type ProcessTreeOps = SweepOps;

/** The part of the process-tree ops the group reap uses. */
export type GroupReapOps = Pick<ProcessTreeOps, "killGroup">;

// Production uses `process.kill` and `/bin/ps`. One seam covers the group reap AND the
// detached sweep, so a test that fakes the kill can never leave a real sweep live.
// Exported for a real-process test that wraps one of them.
export const osProcessTreeOps: ProcessTreeOps = {
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
  continueGroup(pgid: number): void {
    process.kill(-pgid, "SIGCONT");
  },
  listProcesses: (timeoutMs, scope) => listProcessTableMarkingDaemon(timeoutMs, scope),
};

// The ops used when a caller does not inject them. A test seam so session lifecycle
// tests can observe (and neutralize) the group SIGKILL without a real signal, and
// without every session/terminate call site taking an ops param.
let activeOps: ProcessTreeOps = osProcessTreeOps;

/** The operations currently selected by the shared shutdown seam. */
export function activeProcessTreeOps(): ProcessTreeOps {
  return activeOps;
}

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
export function quietProcessTree(): Omit<ProcessTreeOps, "killGroup"> {
  const stopped = new Set<number>();
  return {
    stopGroup: (pgid) => void stopped.add(pgid),
    continueGroup: (pgid) => void stopped.delete(pgid),
    listProcesses: () =>
      Promise.resolve([...stopped].map((pgid) => ({ ...QUIET_ROW, pid: pgid, pgid }))),
  };
}

const QUIET_ROW = { ...UNREAD, ppid: 1, stopped: true };

export function resetProcessTreeOpsForTests(): void {
  activeOps = osProcessTreeOps;
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
