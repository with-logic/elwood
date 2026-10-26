/**
 * A state root deep under `cwd` is made one directory at a time, and each directory above it
 * is checked for symlinks a bounded number of times, not again at every level below it, which
 * made setup quadratic in the root's depth (PRD §8.1, §12A.5, C-STATE-14, C-CLI-15).
 */

import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ensurePrivateStateRoot } from "../../src/state/private-session.ts";
import { prepareStateDir } from "../../src/state/store.ts";
import { tempDir } from "../helpers/tmp.ts";

const looked = vi.hoisted(() => ({ path: "", times: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  /** Counts the checks of the watched path. */
  const lstatSync = (path: string) => {
    if (path === looked.path) looked.times += 1;
    return actual.lstatSync(path);
  };
  return { ...actual, lstatSync };
});

afterEach(() => Object.assign(looked, { path: "", times: 0 }));

test.each([
  ["a session's", (stateDir: string, cwd: string) => prepareStateDir(stateDir, { cwd })],
  ["the CLI's", ensurePrivateStateRoot],
] as const)("C-STATE-14 C-CLI-15 %s stateDir 40 levels under cwd checks cwd a bounded number of times", (_setup, prepare) => {
  const cwd = fs.realpathSync.native(tempDir("elwood-state-root-depth-"));
  const stateDir = join(cwd, ...Array.from({ length: 40 }, (_, level) => `l${level}`));
  looked.path = cwd;
  prepare(stateDir, cwd);
  expect(fs.statSync(join(stateDir, "sessions")).isDirectory()).toBe(true);
  expect(looked.times).toBeLessThan(10);
});
