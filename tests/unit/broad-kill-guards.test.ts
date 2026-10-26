/**
 * The real-process tests' last-resort cleanup refuses a match broad enough to reach
 * processes the test did not start (PRD §12, C-E2E-03): an empty or short kill marker,
 * and a directory other than a scratch directory strictly inside the OS temp directory.
 * An empty path, for one, resolves to the cwd, and a `/` prefix names every process.
 * Every call here records its kill targets instead of signaling them, so even a helper
 * without these refusals could not touch a real process. The one process really
 * signaled is the test's own, by its exact pid.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { processesUnder, stopProcessesUnder } from "../e2e/scratch-processes.ts";
import {
  delay,
  killGroupsWhoseCommandHas,
  killIfCommandHas,
  POLL_INTERVAL_MS,
  pidExists,
  processRows,
  type Send,
} from "../helpers/process-liveness.ts";

/** A `Send` that only records what it was asked to signal. */
function recorder(): { readonly send: Send; readonly targets: number[] } {
  const targets: number[] = [];
  return { send: (pid) => void targets.push(pid), targets };
}

describe("C-E2E-03 cleanup never matches broadly", () => {
  test.each(["", "   ", "sleep", "/tmp/elwood"])("refuses the kill marker %j", (marker) => {
    const { send, targets } = recorder();
    expect(() => killGroupsWhoseCommandHas(marker, send)).toThrow(/shorter than 12/);
    expect(() => killIfCommandHas(process.pid, marker, send)).toThrow(/shorter than 12/);
    expect(targets.length, "kill targets").toBe(0);
  });

  test("refuses a directory that is not a scratch directory in the temp directory", () => {
    const gone = mkdtempSync(join(tmpdir(), "elwood-broad-kill-"));
    rmSync(gone, { recursive: true });
    for (const dir of ["", ".", "/", process.cwd(), tmpdir(), join(tmpdir(), ".."), gone]) {
      const { send, targets } = recorder();
      expect(() => stopProcessesUnder(dir, send), dir).toThrow(/not a scratch directory|ENOENT/);
      expect(() => processesUnder(dir, []), dir).toThrow(/not a scratch directory|ENOENT/);
      expect(() => processesUnder(dir), dir).toThrow(/not a scratch directory|ENOENT/);
      expect(targets.length, `kill targets for ${JSON.stringify(dir)}`).toBe(0);
    }
  }, 120_000);

  test("a scratch directory nothing runs from is stopped without a signal", () => {
    const dir = mkdtempSync(join(tmpdir(), "elwood-broad-kill-"));
    const { send, targets } = recorder();
    try {
      stopProcessesUnder(dir, send);
      expect(processesUnder(dir)).toEqual([]);
      expect(targets).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("a narrow match reaches the injected sender with only the matching process", async () => {
    // A process of this test's own, in a group of its own, whose command line names a
    // path in a fresh scratch directory. Only its exact pid is ever really signaled.
    const dir = mkdtempSync(join(tmpdir(), "elwood-broad-kill-"));
    const marker = join(dir, "hold");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)", marker], {
      detached: true,
      stdio: "ignore",
    });
    const pid = child.pid ?? 0;
    try {
      while (!processRows().some((row) => row.pid === pid && row.command.includes(marker))) {
        await delay(POLL_INTERVAL_MS);
      }
      const calls: [number, NodeJS.Signals][] = [];
      const record: Send = (target, signal) => void calls.push([target, signal]);
      killIfCommandHas(pid, marker, record);
      expect(killGroupsWhoseCommandHas(marker, record)).toBe(1);
      expect(calls).toEqual([
        [pid, "SIGKILL"],
        [-pid, "SIGKILL"],
      ]);
      const stops: [number, NodeJS.Signals][] = [];
      stopProcessesUnder(dir, (target, signal) => {
        stops.push([target, signal]);
        if (target === pid) process.kill(pid, signal);
      });
      expect(stops).toEqual([[pid, "SIGTERM"]]);
    } finally {
      if (pidExists(pid)) process.kill(pid, "SIGKILL");
      rmSync(dir, { recursive: true });
    }
  });
});
