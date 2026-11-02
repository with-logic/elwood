/**
 * Cleanup for the scratch-process e2e fixtures (PRD §12, C-E2E-03): bounded process-table
 * reads and cleanup steps whose failures are reported alongside the test's own failure.
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import {
  delay,
  killGroupsWhoseCommandHas,
  type ProcessRow,
  processRows,
} from "../../helpers/process-liveness.ts";
import { stopProcessesUnder, TERM_GRACE_MS } from "../scratch-processes.ts";

type Identity = Pick<ProcessRow, "pid" | "command">;
const describe = (row: Identity) => `${row.pid} ${row.command}`;
/** The pause between probes adds at most 100 ms to noticing a graceful exit. */
const CLEANUP_POLL_MS = 100;
/** Includes table reads, leaving room for SIGKILL after the 3 s graceful window. */
const CLEANUP_TIMEOUT_MS = 10_000;

/** Runs every cleanup step, preserving the body's failure and each cleanup failure. */
export async function runWithCleanup(
  body: () => void | Promise<void>,
  cleanups: readonly (() => void | Promise<void>)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const action of [body, ...cleanups]) {
    try {
      await action();
    } catch (error) {
      failures.push(...(error instanceof AggregateError ? error.errors : [error]));
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Scratch process test failed");
}

/** Descriptions of `rows` still running as the same process, with a bounded optional read. */
export function stillRunning(rows: readonly Identity[], timeoutMs?: number): readonly string[] {
  const live = new Set(
    processRows(timeoutMs)
      .filter((row) => !row.stat.startsWith("Z"))
      .map(describe),
  );
  return rows.map(describe).filter((row) => live.has(row));
}

/** The remaining process-table read budget, at least 1 ms so an expired read stays bounded. */
const remaining = (deadline: number) => Math.max(1, Math.ceil(deadline - performance.now()));

function signalAll(rows: readonly Identity[], name: NodeJS.Signals, deadline: number): void {
  const wanted = new Set(rows.map(describe));
  for (const row of processRows(remaining(deadline))) {
    if (!wanted.has(describe(row))) continue;
    try {
      process.kill(row.pid, name);
    } catch {
      // It exited between the read and the kill.
    }
  }
}

/** Ends `rows` with SIGTERM and SIGKILL; one cleanup deadline bounds every table read. */
export async function endAll(rows: readonly Identity[]): Promise<void> {
  const deadline = performance.now() + CLEANUP_TIMEOUT_MS;
  signalAll(rows, "SIGTERM", deadline);
  const graceDeadline = Math.min(deadline, performance.now() + TERM_GRACE_MS);
  while (performance.now() < graceDeadline && stillRunning(rows, remaining(deadline)).length > 0)
    await delay(Math.min(CLEANUP_POLL_MS, remaining(graceDeadline)));
  signalAll(rows, "SIGKILL", deadline);
}

/** Stops what runs from `home`, then attempts the fallback even if that first cleanup fails. */
export async function cleanUp(home: string | undefined, rows: readonly Identity[]): Promise<void> {
  await runWithCleanup(() => {
    if (home !== undefined && existsSync(home)) {
      stopProcessesUnder(home);
      rmSync(home, { recursive: true, force: true });
    }
  }, [() => endAll(rows)]);
}

/** Marker cleanup does not depend on discovery or on having read the child's PID. */
export async function cleanFixture(
  parent: ChildProcess | undefined,
  marker: string,
  dir: string,
): Promise<void> {
  await runWithCleanup(() => {
    parent?.kill("SIGKILL");
  }, [
    () => {
      killGroupsWhoseCommandHas(marker);
    },
    () => rmSync(dir, { recursive: true, force: true }),
  ]);
}
