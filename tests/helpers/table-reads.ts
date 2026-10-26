/**
 * Real process-table polling for the real-process tests (PRD §5.3 and §9.4, C-LIFE-10).
 * A signal shows in a read only once it is delivered, so a test reads until the row it
 * waits on changes, bounded in wall time so a failure still leaves its cleanup time.
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { SweepOps } from "../../src/runtime/shutdown/detached-sweep/index.ts";
import { listProcessTable, type ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { osProcessTreeOps } from "../../src/runtime/shutdown/reap-tree.ts";
import { delay, POLL_INTERVAL_MS } from "./process-liveness.ts";

/**
 * Production's real reads, each started `lateMs` late, as on a loaded host where one read
 * can take over half a second; each read gets what is left of its bound.
 */
export function lateRealReads(lateMs: number): SweepOps["listProcesses"] {
  return async (timeoutMs, scope) => {
    await sleep(lateMs);
    return osProcessTreeOps.listProcesses(Math.max(1, timeoutMs - lateMs), scope);
  };
}

/**
 * Reads the real table until `pid`'s row satisfies `check`, for at most five seconds in
 * all, and returns the last read: the caller asserts on it, so a timeout fails there.
 */
export async function readUntil(
  pid: number,
  check: (row: ProcessEntry | undefined) => boolean,
): Promise<readonly ProcessEntry[]> {
  const deadline = performance.now() + 5_000;
  let table: readonly ProcessEntry[] = [];
  for (let remainingMs = 5_000; remainingMs > 0; ) {
    table = await listProcessTable(remainingMs);
    if (check(table.find((row) => row.pid === pid))) return table;
    await delay(POLL_INTERVAL_MS);
    remainingMs = Math.ceil(deadline - performance.now());
  }
  return table;
}
