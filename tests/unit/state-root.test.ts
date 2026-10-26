/**
 * A state root never brings back the session's missing working directory: it is made only while
 * `cwd` exists, a root at or under `cwd` only below it, and a root elsewhere with its missing
 * parents (PRD §8.1, C-STATE-14).
 */

import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { prepareStateDir } from "../../src/state/store.ts";
import { tempDir } from "../helpers/tmp.ts";

const placements = [
  {
    name: "the default",
    at: (cwd: string) => join(cwd, ".elwood"),
    isImplicitDefaultStateDir: true,
  },
  { name: "its own, nested under cwd,", at: (cwd: string) => join(cwd, "state", "nested") },
  { name: "its own, at cwd itself,", at: (cwd: string) => cwd },
  {
    name: "its own, under cwd spelled in another case,",
    at: (cwd: string) => join(cwd, "..", "DELETED-WORKTREE", "state"),
  },
  {
    name: "its own, outside cwd,",
    at: () => join(tempDir("elwood-state-root-elsewhere-"), "absent", "state"),
  },
];

test.each(
  placements,
)("C-STATE-14 $name state directory is never made where cwd is missing", (place) => {
  const cwd = join(tempDir("elwood-state-root-"), "deleted-worktree");
  const stateDir = place.at(cwd);
  const setup = { cwd, isImplicitDefaultStateDir: place.isImplicitDefaultStateDir === true };
  expect(() => prepareStateDir(stateDir, setup)).toThrow(
    expect.objectContaining({ code: "ENOENT" }),
  );
  expect(existsSync(cwd), "the worktree must not be recreated").toBe(false);
  expect(existsSync(stateDir), "nor its state").toBe(false);
});

test("C-STATE-14 a state directory under an existing cwd is made below it, again and again", () => {
  const cwd = tempDir("elwood-state-root-");
  const stateDir = join(cwd, "state", "nested");
  for (const round of [1, 2]) {
    prepareStateDir(stateDir, { cwd });
    expect(statSync(join(stateDir, "sessions")).isDirectory(), `round ${round}`).toBe(true);
  }
  expect(statSync(join(cwd, "state")).mode & 0o777).toBe(0o700);
  prepareStateDir(cwd, { cwd });
  expect(statSync(join(cwd, "sessions")).isDirectory()).toBe(true);
});

test("C-STATE-14 a state directory outside cwd gets its missing parents", () => {
  const cwd = tempDir("elwood-state-root-");
  const stateDir = join(tempDir("elwood-state-root-elsewhere-"), "absent", "state");
  prepareStateDir(stateDir, { cwd });
  expect(statSync(join(stateDir, "sessions")).isDirectory()).toBe(true);
});

test("C-STATE-14 a cwd that cannot be resolved fails state setup", () => {
  const file = join(tempDir("elwood-state-root-"), "file");
  writeFileSync(file, "");
  const cwd = join(file, "worktree");
  const stateDir = join(tempDir("elwood-state-root-elsewhere-"), "state");
  expect(() => prepareStateDir(stateDir, { cwd })).toThrow(
    expect.objectContaining({ code: "ENOTDIR" }),
  );
  expect(existsSync(stateDir)).toBe(false);
});
