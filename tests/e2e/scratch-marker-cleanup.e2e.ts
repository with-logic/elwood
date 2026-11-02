/**
 * A failed scratch fixture still cleans up its live detached child without its PID
 * (PRD §12, C-E2E-03), through the same fallback the normal process test uses.
 */

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { delay, killGroupsWhoseCommandHas, processRows } from "../helpers/process-liveness.ts";
import { cleanFixture, runWithCleanup } from "./scratch-processes/cleanup.ts";
import { scratchTreeReady, spawnScratchTree } from "./scratch-processes/fixture.ts";

const matching = (marker: string) =>
  processRows(10_000).filter((row) => !row.stat.startsWith("Z") && row.command.includes(marker));

test("C-E2E-03 marker cleanup stops a live child after failure before its PID is read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elwood_e2e_marker_cleanup-"));
  const marker = `elwood-scratch-fixture-${randomUUID()}`;
  const failure = new Error("controlled failure before PID capture");
  let parent: ChildProcess | undefined;
  try {
    await assert.rejects(
      runWithCleanup(async () => {
        parent = spawnScratchTree(dir, marker);
        await scratchTreeReady(parent);
        assert.equal(matching(marker).length, 2, "parent and detached child are live");
        // stdout's PID is deliberately never read, and normal discovery/cleanup never runs.
        throw failure;
      }, [() => cleanFixture(parent, marker, dir)]),
      (error) => error === failure,
    );
    const deadline = performance.now() + 10_000;
    while (matching(marker).length > 0 && performance.now() < deadline) await delay(20);
    assert.deepEqual(matching(marker), [], "the failed fixture's child outlived marker cleanup");
  } finally {
    // Independent fallback also removes the child when the cleanup regression is broken.
    parent?.kill("SIGKILL");
    killGroupsWhoseCommandHas(marker);
    rmSync(dir, { recursive: true, force: true });
  }
});
