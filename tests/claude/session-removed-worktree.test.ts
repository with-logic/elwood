/**
 * A running session whose worktree, holding its default state directory, is removed never
 * recreates it: its later state writes fail instead of making the missing directories again
 * (PRD §8.1, C-STATE-14).
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startClaude } from "../../src/index.ts";
import { installFakes, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

test("C-STATE-14 a loop created after the worktree is removed fails without recreating it", async () => {
  installFakes();
  const cwd = join(tempDir(), "worktree");
  mkdirSync(cwd);
  const session = await startClaude({ cwd });
  try {
    rmSync(cwd, { recursive: true });
    const creating = session.createLoop({ mode: "fixed", intervalMs: 60_000, message: "later" });
    await expect(creating).rejects.toMatchObject({ code: "loop_persistence_failed" });
    expect(existsSync(cwd), "the worktree must not be recreated").toBe(false);
  } finally {
    await session.stop();
  }
  expect(existsSync(cwd)).toBe(false);
});
