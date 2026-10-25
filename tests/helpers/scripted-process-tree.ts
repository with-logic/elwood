/**
 * Scripted process-tree fakes for the detached-sweep tests (PRD §5.3 and §9.4,
 * C-LIFE-10): each listing serves the next scripted table, and every stop, kill, and
 * listing is logged, so no test signals or reads a real process.
 */

import type { SweepOps } from "../../src/runtime/shutdown/detached-sweep/index.ts";
import type { ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";

export const LEADER = 5000;

/** A `leaderExited` that never sees the exit. */
export const alive = (): boolean => false;

export const leaderRow: ProcessEntry = {
  pid: LEADER,
  ppid: process.pid,
  pgid: LEADER,
  zombie: false,
  stopped: false,
};

/** A setsid hook heading its own group, under the leader unless `ppid` says otherwise. */
export const hook = (
  pid: number,
  { zombie = false, ppid = LEADER }: { readonly zombie?: boolean; readonly ppid?: number } = {},
): ProcessEntry => ({ pid, ppid, pgid: pid, zombie, stopped: false });

export const errno = (code: string): Error =>
  Object.assign(new Error(`raw ${code} detail`), { code });

/**
 * Fake ops that serve one table per listing (the last repeats) and log every call. A
 * group's rows read as stopped once a stop of that group returned, as a delivered
 * SIGSTOP leaves them; `asRead` applies the same to rows a test lists itself.
 */
export function scripted(
  tables: readonly (readonly ProcessEntry[])[],
  overrides: Partial<SweepOps> = {},
): {
  ops: SweepOps;
  calls: string[];
  timeouts: number[];
  asRead: (rows: readonly ProcessEntry[]) => ProcessEntry[];
} {
  const calls: string[] = [];
  const timeouts: number[] = [];
  const delivered = new Set<number>();
  const asRead = (rows: readonly ProcessEntry[]) =>
    rows.map((row) => (delivered.has(row.pgid) ? { ...row, stopped: true } : row));
  const stop = overrides.stopGroup ?? ((pgid: number) => void calls.push(`stop ${pgid}`));
  let listing = 0;
  const ops: SweepOps = {
    killGroup: (pgid) => void calls.push(`kill ${pgid}`),
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
      delivered.add(pgid);
    },
  };
  return { ops, calls, timeouts, asRead };
}
