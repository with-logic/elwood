/**
 * Scripted process-tree fakes for the detached-sweep tests (PRD §5.3 and §9.4,
 * C-LIFE-10): each listing serves the next scripted table, and every stop, kill, and
 * listing is logged, so no test signals or reads a real process.
 */

import { vi } from "vitest";
import type { SweepOps } from "../../src/runtime/shutdown/detached-sweep/index.ts";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";

export const LEADER = 5000;

/** A `leaderExited` predicate that never reports the leader's exit. */
export const leaderNeverExits = (): boolean => false;

export const leaderRow: ProcessEntry = {
  pid: LEADER,
  ppid: process.pid,
  pgid: LEADER,
  zombie: false,
  stopped: false,
  name: "codex",
  shared: false,
};

/**
 * A descendant row: by default a setsid hook heading its own group under the leader,
 * running. `pgid`, `ppid`, and the state can each be set to model a multi-process group,
 * and the short name and daemon mark to model what it runs.
 */
export const hook = (
  pid: number,
  {
    zombie = false,
    ppid = LEADER,
    pgid = pid,
    stopped = false,
    name = "sh",
    shared = false,
  }: {
    readonly zombie?: boolean;
    readonly ppid?: number;
    readonly pgid?: number;
    readonly stopped?: boolean;
    readonly name?: string;
    readonly shared?: boolean;
  } = {},
): ProcessEntry => ({ pid, ppid, pgid, zombie, stopped, name, shared });

/**
 * `ops` under a fake clock that each listing advances 100 ms, so a sweep that never
 * converges meets its deadline in a few reads (the caller restores `performance.now`).
 */
export function ticking(ops: SweepOps): SweepOps {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  return {
    ...ops,
    listProcesses: (timeoutMs) => {
      clock += 100;
      return ops.listProcesses(timeoutMs);
    },
  };
}

export const errno = (code: string): Error =>
  Object.assign(new Error(`raw ${code} detail`), { code });

/**
 * Fake ops that serve one table per listing (the last repeats) and log every call. A
 * group's rows read as stopped once a stop of that group returned, as a delivered
 * SIGSTOP leaves them; `asRead` applies the same to rows a test lists itself. A pid in
 * `forkedDuringStop` misses every stop of its group sent before the first listing that
 * shows it, as a child forked while `killpg` signals its group can; a later stop reaches it.
 */
export function scripted(
  tables: readonly (readonly ProcessEntry[])[],
  overrides: Partial<SweepOps> = {},
  forkedDuringStop: ReadonlySet<number> = new Set(),
): {
  ops: SweepOps;
  calls: string[];
  timeouts: number[];
  asRead: (rows: readonly ProcessEntry[]) => ProcessEntry[];
} {
  const calls: string[] = [];
  const timeouts: number[] = [];
  const stops = new Map<number, number>();
  const missed = new Map<number, number>();
  const reached = (row: ProcessEntry): boolean => {
    const sent = stops.get(row.pgid) ?? 0;
    if (!forkedDuringStop.has(row.pid)) return sent > 0;
    const before = missed.get(row.pid) ?? sent;
    missed.set(row.pid, before);
    return sent > before;
  };
  const asRead = (rows: readonly ProcessEntry[]) =>
    rows.map((row) => (reached(row) ? { ...row, stopped: true } : row));
  const stop = overrides.stopGroup ?? ((pgid: number) => void calls.push(`stop ${pgid}`));
  let listing = 0;
  const ops: SweepOps = {
    killGroup: (pgid) => void calls.push(`kill ${pgid}`),
    continueGroup: (pgid) => void calls.push(`cont ${pgid}`),
    listProcesses: (timeoutMs) => {
      timeouts.push(timeoutMs);
      calls.push("list");
      const table = tables[Math.min(listing, tables.length - 1)] ?? [];
      listing += 1;
      return Promise.resolve(asRead(table));
    },
    ...overrides,
    stopGroup: (pgid) => {
      stop(pgid);
      stops.set(pgid, (stops.get(pgid) ?? 0) + 1);
    },
  };
  return { ops, calls, timeouts, asRead };
}
