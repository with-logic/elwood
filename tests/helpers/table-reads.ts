/**
 * Real process-table polling for the real-process tests (PRD §5.3 and §9.4, C-LIFE-10).
 * A signal shows in a read only once it is delivered, so a test reads until the row it
 * waits on changes, bounded in wall time so a failure still leaves its cleanup time.
 */

import { listProcessTable, type ProcessEntry } from "../../src/runtime/shutdown/process-table.ts";
import { delay, POLL_INTERVAL_MS } from "./process-liveness.ts";

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
