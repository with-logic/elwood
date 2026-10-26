/**
 * A `cwd` removed after state setup resolved it is not brought back: each directory below it
 * is made inside its parent, so the first one fails with ENOENT. That holds for a `stateDir`
 * spelled in another letter case, which a case-insensitive volume puts under `cwd`
 * (PRD §8.1, C-STATE-14).
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { prepareStateDir } from "../../src/state/store.ts";
import { tempDir } from "../helpers/tmp.ts";

const removal = vi.hoisted(() => ({ path: "", at: 2, resolutions: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  /** Resolves like the real call, then removes the watched path on its `at`th resolution. */
  const native = (path: string) => {
    const real = actual.realpathSync.native(path);
    if (path === removal.path && ++removal.resolutions === removal.at) {
      actual.rmSync(path, { recursive: true });
    }
    return real;
  };
  const realpathSync = (path: string) => actual.realpathSync(path);
  return { ...actual, realpathSync: Object.assign(realpathSync, { native }) };
});

afterEach(() => {
  removal.path = "";
  removal.at = 2;
  removal.resolutions = 0;
});

/** Whether the temporary directory's volume ignores letter case. */
function tmpFoldsCase(): boolean {
  const probe = fs.mkdtempSync(join(tmpdir(), "elwood-state-root-Case-"));
  try {
    return fs.existsSync(join(dirname(probe), basename(probe).toLowerCase()));
  } finally {
    fs.rmSync(probe, { recursive: true });
  }
}

test("C-STATE-14 a cwd removed once resolved fails the next state directory", () => {
  const cwd = tempDir("elwood-state-root-race-");
  removal.path = cwd;
  expect(() => prepareStateDir(join(cwd, "state", "nested"), { cwd })).toThrow(
    expect.objectContaining({ code: "ENOENT" }),
  );
  expect(removal.resolutions).toBe(2);
  expect(fs.existsSync(cwd), "the worktree must not be recreated").toBe(false);
});

test.skipIf(!tmpFoldsCase())(
  "C-STATE-14 a cwd removed once resolved fails a stateDir spelled in another case",
  () => {
    const cwd = join(tempDir("elwood-state-root-race-"), "Worktree");
    fs.mkdirSync(cwd);
    removal.path = cwd;
    removal.at = 1; // the root's own resolution reaches `cwd` through its other spelling
    const stateDir = join(dirname(cwd), "worktree", "state", "nested");
    expect(() => prepareStateDir(stateDir, { cwd })).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(removal.resolutions).toBe(1);
    expect(fs.existsSync(cwd), "the worktree must not be recreated").toBe(false);
  },
);
