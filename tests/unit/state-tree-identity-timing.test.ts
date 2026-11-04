/** State setup checks the captured workspace before every attempt (C-API-61, C-STATE-14). */
import { mkdirSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { setPlatformForTests } from "../../src/runtime/seams.ts";
import {
  assertLaunchDirectoryUnchanged,
  checkLaunchDirectory,
} from "../../src/runtime/session/launch-directory.ts";
import { makeStateTree } from "../../src/state/root.ts";
import { tempDir } from "../helpers/tmp.ts";

beforeEach(() => setPlatformForTests("darwin"));

async function workspace() {
  const base = realpathSync(tempDir("elwood-state-tree-identity-"));
  const cwd = join(base, "worktree");
  const replacement = join(base, "replacement");
  mkdirSync(cwd);
  mkdirSync(replacement);
  writeFileSync(join(replacement, "keep"), "replacement");
  const directory = await checkLaunchDirectory("claude", cwd);
  return {
    cwd,
    assertCwdUnchanged: () => assertLaunchDirectoryUnchanged(directory),
    swap: () => {
      renameSync(cwd, join(base, "original"));
      renameSync(replacement, cwd);
    },
  };
}

test("C-API-61 C-STATE-14 a prior replacement is rejected before the first state-tree write", async () => {
  const { cwd, assertCwdUnchanged, swap } = await workspace();
  const makeTree = vi.fn(() => writeFileSync(join(cwd, "unexpected-state"), "wrong workspace"));
  swap();
  expect(() => makeStateTree(cwd, makeTree, undefined, assertCwdUnchanged)).toThrow(
    expect.objectContaining({ code: "claude_start_failed", details: { cwd } }),
  );
  expect(makeTree).not.toHaveBeenCalled();
  expect(readdirSync(cwd)).toEqual(["keep"]);
});

test("C-API-61 C-STATE-14 a replacement after ENOENT is rejected before the retry writes", async () => {
  const { cwd, assertCwdUnchanged, swap } = await workspace();
  const makeTree = vi.fn(() => {
    if (makeTree.mock.calls.length === 1) {
      try {
        mkdirSync(join(cwd, "absent", "state"));
      } catch (error) {
        swap();
        throw error;
      }
    } else writeFileSync(join(cwd, "unexpected-retry-state"), "wrong workspace");
  });
  expect(() => makeStateTree(cwd, makeTree, undefined, assertCwdUnchanged)).toThrow(
    expect.objectContaining({ code: "claude_start_failed", details: { cwd } }),
  );
  expect(makeTree).toHaveBeenCalledTimes(1);
  expect(readdirSync(cwd)).toEqual(["keep"]);
});
