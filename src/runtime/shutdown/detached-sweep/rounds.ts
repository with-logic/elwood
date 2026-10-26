/**
 * One round of the detached sweep (PRD §5.3 and §9.4, C-LIFE-10): what the latest table
 * read shows about the groups the sweep has signaled, and which new groups it may stop.
 * A group is "signaled" once a SIGSTOP to it returned, which says nothing about its
 * members yet: `kill()` has only sent the signal, and `ps` reads each row at its own
 * moment, so a process counts as held only when this read AND the one before it showed
 * it stopped inside a signaled group. A held parent can neither reap an exited child,
 * which keeps that child's group id from being reused, nor start a process the next
 * read could miss. A signaled group can still hold a running member: `killpg` signals
 * the members it finds, so a child forked while it runs can miss the SIGSTOP.
 */

import { errnoCode } from "../../../core/errors.ts";
import type { ProcessEntry } from "../process-table.ts";
import type { DaemonScope } from "../shared-daemon.ts";
import type { SweepFailures } from "./failures.ts";

/**
 * The process operations the sweep drives. Scripted tests inject fakes that signal
 * nothing; the real-process tests pass OS-backed operations that do.
 */
export type SweepOps = {
  /** SIGSTOPs the process group `pgid`. */
  readonly stopGroup: (pgid: number) => void;
  /** SIGKILLs the process group `pgid`; tolerates an already-empty group. */
  readonly killGroup: (pgid: number) => void;
  /** SIGCONTs the process group `pgid`: one the sweep stopped but must not kill. */
  readonly continueGroup: (pgid: number) => void;
  /** Lists the host process table within `timeoutMs`, marking `shared` rows in `scope`. */
  readonly listProcesses: (
    timeoutMs: number,
    scope?: DaemonScope,
  ) => Promise<readonly ProcessEntry[]>;
};

export type SweepState = {
  /** Groups a SIGSTOP returned for, the leader's included: signaled, not yet held. */
  readonly signaledGroupIds: Set<number>;
  /** The descendant groups among them, in the order signaled: SIGKILLed in reverse. */
  readonly signaledDescendantGroupIds: number[];
  /** Pids the previous read showed stopped inside a signaled group. */
  stoppedPidsLastRead: ReadonlySet<number>;
  /** Groups whose SIGSTOP failed for a reason other than the group being gone. */
  readonly unstoppable: Map<number, unknown>;
  /** The live descendant groups in the latest read, each with its parents' rows. */
  live: ReadonlyMap<number, ReadonlySet<ProcessEntry>>;
  /** Signaled groups not yet held: see `unheldGroups`, plus any signaled since that read. */
  unheld: readonly number[];
  /** The latest table a read returned, by which the kill pass picks the groups to resume. */
  latest: readonly ProcessEntry[];
  readonly failures: SweepFailures;
};

export function newSweepState(failures: SweepFailures): SweepState {
  return {
    signaledGroupIds: new Set(),
    signaledDescendantGroupIds: [],
    stoppedPidsLastRead: new Set(),
    unstoppable: new Map(),
    live: new Map(),
    unheld: [],
    latest: [],
    failures,
  };
}

/** The live groups in the latest read that the sweep has not tried to stop. */
export function unreachedGroups(state: SweepState): number[] {
  return [...state.live.keys()].filter(
    (group) => !(state.signaledGroupIds.has(group) || state.unstoppable.has(group)),
  );
}

/**
 * The signaled groups this read does not hold: each with a live member that this read
 * and the one before did not both show stopped, and the leader's own group while this
 * read does not show the leader live, since its exit leaves descendants out of reach.
 */
export function unheldGroups(
  table: readonly ProcessEntry[],
  state: SweepState,
  leaderPid: number,
): number[] {
  const unheld = new Set<number>();
  if (!table.some((row) => row.pid === leaderPid && !row.zombie)) unheld.add(leaderPid);
  for (const row of table) {
    if (row.zombie || !state.signaledGroupIds.has(row.pgid)) continue;
    if (!(row.stopped && state.stoppedPidsLastRead.has(row.pid))) unheld.add(row.pgid);
  }
  return [...unheld];
}

/**
 * Stops each unreached group that a held parent anchors, after noting which rows this
 * read shows stopped for the NEXT read to rely on.
 */
export function stopAnchoredGroups(
  table: readonly ProcessEntry[],
  ops: SweepOps,
  state: SweepState,
): void {
  const unreached = new Set(unreachedGroups(state));
  const anchored = [...state.live].filter(
    ([group, parents]) => unreached.has(group) && [...parents].some((p) => isAnchor(p, state)),
  );
  state.stoppedPidsLastRead = new Set(
    table
      .filter((row) => row.stopped && state.signaledGroupIds.has(row.pgid))
      .map((row) => row.pid),
  );
  for (const [group] of anchored) stopGroup(group, ops, state);
}

/**
 * Sends SIGSTOP again to each signaled group this read shows with a live member that is
 * not stopped, such as a child forked while the group's first stop went out (it keeps
 * running until signaled; macOS showed one in 150 stops of a shell forking pipelines,
 * and a real Claude teardown's login shell had one still running three seconds later).
 * Each id still names its group: the caller has just seen the leader alive, and a
 * descendant group stays anchored by the held parent the kill pass relies on too.
 */
export function restopEscapedGroups(
  table: readonly ProcessEntry[],
  ops: SweepOps,
  state: SweepState,
): void {
  const escaped = table.filter(
    (row) => !(row.zombie || row.stopped) && state.signaledGroupIds.has(row.pgid),
  );
  for (const group of new Set(escaped.map((row) => row.pgid))) {
    try {
      ops.stopGroup(group);
    } catch (error) {
      if (errnoCode(error) === "ESRCH") continue;
      const descendant = state.signaledDescendantGroupIds.includes(group);
      const reason = descendant
        ? "could not stop a live descendant group"
        : "could not stop the leader's group";
      state.failures.record(reason, error, [group]);
    }
  }
}

/** A parent this read and the one before both showed stopped inside a signaled group. */
function isAnchor(parent: ProcessEntry, state: SweepState): boolean {
  return (
    parent.stopped &&
    state.signaledGroupIds.has(parent.pgid) &&
    state.stoppedPidsLastRead.has(parent.pid)
  );
}

/** A group that vanished (`ESRCH`) needs nothing; any other refusal is judged at the end. */
function stopGroup(group: number, ops: SweepOps, state: SweepState): void {
  try {
    ops.stopGroup(group);
    state.signaledDescendantGroupIds.push(group);
    state.signaledGroupIds.add(group);
    state.unheld = [...state.unheld, group];
  } catch (error) {
    if (errnoCode(error) !== "ESRCH") state.unstoppable.set(group, error);
  }
}
