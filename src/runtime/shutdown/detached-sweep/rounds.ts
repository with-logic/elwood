/**
 * One round of the detached sweep (PRD §5.3 and §9.4, C-LIFE-10): what the latest table
 * read shows about the groups the sweep has stopped, and which new groups it may stop.
 * A `kill()` that returns has only sent the SIGSTOP, and `ps` reads each row at its own
 * moment, so a process counts as held only when this read AND the one before it showed
 * it stopped inside a group the sweep stopped. A held parent can neither reap an exited
 * child, which keeps that child's group id from being reused, nor start a process the
 * next read could miss. A stopped group can still hold a running member: `killpg`
 * signals the members it finds, so a child forked while it runs can miss the SIGSTOP.
 */

import { errnoCode } from "../../../core/errors.ts";
import type { ProcessEntry } from "../process-table.ts";
import type { SweepFailures } from "./failures.ts";

/** The process operations the sweep drives; injected so tests never touch real processes. */
export type SweepOps = {
  /** SIGSTOPs the process group `pgid`. */
  readonly stopGroup: (pgid: number) => void;
  /** SIGKILLs the process group `pgid`; tolerates an already-empty group. */
  readonly killGroup: (pgid: number) => void;
  /** Lists the host process table, rejecting after `timeoutMs`. */
  readonly listProcesses: (timeoutMs: number) => Promise<readonly ProcessEntry[]>;
};

export type SweepState = {
  /** Groups whose SIGSTOP returned: the leader's, if its stop did, and every stopped one. */
  readonly frozen: Set<number>;
  /** Descendant groups whose SIGSTOP returned, in order: SIGKILLed in reverse. */
  readonly stopped: number[];
  /** Pids the previous read showed stopped inside a frozen group. */
  stoppedLastRead: ReadonlySet<number>;
  /** Groups whose SIGSTOP failed for a reason other than the group being gone. */
  readonly unstoppable: Map<number, unknown>;
  /** The live descendant groups in the latest read, each with its parents' rows. */
  live: ReadonlyMap<number, ReadonlySet<ProcessEntry>>;
  /** Frozen groups not yet held: with a live member the latest read did not hold, or since stopped. */
  unheld: readonly number[];
  readonly failures: SweepFailures;
};

export function newSweepState(failures: SweepFailures): SweepState {
  return {
    frozen: new Set(),
    stopped: [],
    stoppedLastRead: new Set(),
    unstoppable: new Map(),
    live: new Map(),
    unheld: [],
    failures,
  };
}

/** The live groups in the latest read that the sweep has not tried to stop. */
export function unreachedGroups(state: SweepState): number[] {
  return [...state.live.keys()].filter(
    (group) => !(state.frozen.has(group) || state.unstoppable.has(group)),
  );
}

/** The frozen groups with a live member this read and the one before did not both show stopped. */
export function unheldGroups(table: readonly ProcessEntry[], state: SweepState): number[] {
  const unheld = new Set<number>();
  for (const row of table) {
    if (row.zombie || !state.frozen.has(row.pgid)) continue;
    if (!(row.stopped && state.stoppedLastRead.has(row.pid))) unheld.add(row.pgid);
  }
  return [...unheld];
}

/**
 * Stops each unreached group that a held parent anchors, after noting which rows this
 * read shows stopped for the NEXT read to rely on. Returns whether another read can
 * still reach a group: one was just stopped, or a group still waits on a parent in a
 * frozen group that is not held yet.
 */
export function stopAnchoredGroups(
  unreached: readonly number[],
  table: readonly ProcessEntry[],
  ops: SweepOps,
  state: SweepState,
): boolean {
  const unreachedSet = new Set(unreached);
  const pending = [...state.live].filter(([group]) => unreachedSet.has(group));
  const anchored = pending.filter(([, parents]) => [...parents].some((p) => isAnchor(p, state)));
  const waiting = pending.some(([, parents]) =>
    [...parents].some((parent) => state.frozen.has(parent.pgid)),
  );
  state.stoppedLastRead = new Set(
    table.filter((row) => row.stopped && state.frozen.has(row.pgid)).map((row) => row.pid),
  );
  for (const [group] of anchored) stopGroup(group, ops, state);
  return anchored.length > 0 || waiting;
}

/**
 * Sends SIGSTOP again to each frozen group this read shows with a live member that is
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
  const escaped = table.filter((row) => !(row.zombie || row.stopped) && state.frozen.has(row.pgid));
  for (const group of new Set(escaped.map((row) => row.pgid))) {
    try {
      ops.stopGroup(group);
    } catch (error) {
      if (errnoCode(error) === "ESRCH") continue;
      const descendant = state.stopped.includes(group);
      const reason = descendant
        ? "could not stop a live descendant group"
        : "could not stop the leader's group";
      state.failures.record(reason, error, [group]);
    }
  }
}

/** A parent this read and the one before both showed stopped inside a frozen group. */
function isAnchor(parent: ProcessEntry, state: SweepState): boolean {
  return parent.stopped && state.frozen.has(parent.pgid) && state.stoppedLastRead.has(parent.pid);
}

/** A group that vanished (`ESRCH`) needs nothing; any other refusal is judged at the end. */
function stopGroup(group: number, ops: SweepOps, state: SweepState): void {
  try {
    ops.stopGroup(group);
    state.stopped.push(group);
    state.frozen.add(group);
    state.unheld = [...state.unheld, group];
  } catch (error) {
    if (errnoCode(error) !== "ESRCH") state.unstoppable.set(group, error);
  }
}
