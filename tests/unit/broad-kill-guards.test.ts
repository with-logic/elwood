/**
 * The real-process tests' last-resort cleanup refuses a match broad enough to reach
 * processes the test did not start (PRD §12, C-E2E-03): an empty or short kill marker,
 * and a directory other than a scratch directory strictly inside the OS temp directory.
 * An empty path, for one, resolves to the cwd, and a `/` prefix names every process.
 * Every call here records its kill targets instead of signaling them, so even a helper
 * without these refusals could not touch a real process.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { processesUnder, stopProcessesUnder } from "../e2e/scratch-processes.ts";
import {
  killGroupsWhoseCommandHas,
  killIfCommandHas,
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
    expect(() => killGroupsWhoseCommandHas(marker, send)).toThrow(/too broad/);
    expect(() => killIfCommandHas(process.pid, marker, send)).toThrow(/too broad/);
    expect(targets.length, "kill targets").toBe(0);
  });

  test("refuses a directory that is not a scratch directory in the temp directory", () => {
    const gone = mkdtempSync(join(tmpdir(), "elwood-broad-kill-"));
    rmSync(gone, { recursive: true });
    for (const dir of ["", ".", "/", process.cwd(), tmpdir(), join(tmpdir(), ".."), gone]) {
      const { send, targets } = recorder();
      expect(() => stopProcessesUnder(dir, send), dir).toThrow(/not a scratch directory|ENOENT/);
      expect(() => processesUnder(dir, []), dir).toThrow(/not a scratch directory|ENOENT/);
      expect(targets.length, `kill targets for ${JSON.stringify(dir)}`).toBe(0);
    }
  }, 120_000);

  test("a scratch directory nothing runs from is stopped without a signal", () => {
    const dir = mkdtempSync(join(tmpdir(), "elwood-broad-kill-"));
    const { send, targets } = recorder();
    try {
      stopProcessesUnder(dir, send);
      expect(processesUnder(dir, [])).toEqual([]);
      expect(targets).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
