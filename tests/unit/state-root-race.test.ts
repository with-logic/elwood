/**
 * A `cwd` removed after state setup resolved it is not brought back, also for a `stateDir` in
 * another letter case. A `stateDir` elsewhere made meanwhile is taken back, and no more: the undo
 * keeps the start's own failure, gets past a directory already gone, reports one it can't remove,
 * and leaves one another start put its session in. A start whose directory such an undo removed
 * makes it again (PRD §8.1, §12A.5, C-STATE-14, C-CLI-15, C-API-61).
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resetRuntimeSeamsForTests, setPlatformForTests } from "../../src/runtime/seams.ts";
import { recheckLaunchDirectoryOnFailure } from "../../src/runtime/session/launch-directory.ts";
import { secureMkdir } from "../../src/state/files.ts";
import { ensurePrivateStateRoot } from "../../src/state/private-session.ts";
import { prepareStateDir } from "../../src/state/store.ts";
import { tempDir } from "../helpers/tmp.ts";

const fresh = vi.hoisted(() => () => ({
  removing: "", // removed on its `at`th resolution, then `meanwhile` runs; `early`: before it
  at: 2,
  resolutions: 0,
  early: false,
  meanwhile() {},
  making: "", // `before` runs as it is made, its next `times` times
  times: 0,
  before() {},
}));
const race = vi.hoisted(() => ({ now: fresh() }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  // Counted only once resolved, unless `early`, whose resolution then fails.
  const watched = (path: string, early: boolean) =>
    early === race.now.early &&
    path === race.now.removing &&
    ++race.now.resolutions === race.now.at;
  const remove = (path: string) => {
    actual.rmSync(path, { recursive: true });
    race.now.meanwhile();
  };
  const native = (path: string) => {
    if (watched(path, true)) remove(path);
    const real = actual.realpathSync.native(path);
    if (watched(path, false)) remove(path);
    return real;
  };
  const realpathSync = (path: string) => actual.realpathSync(path);
  const mkdirSync = (path: string, options?: fs.MakeDirectoryOptions) => {
    if (path === race.now.making && race.now.times-- > 0) race.now.before();
    return actual.mkdirSync(path, options);
  };
  return { ...actual, mkdirSync, realpathSync: Object.assign(realpathSync, { native }) };
});

afterEach(() => {
  race.now = fresh();
  resetRuntimeSeamsForTests();
});

const prepareSession = (stateDir: string, cwd: string) => prepareStateDir(stateDir, { cwd });
const stateSetups = [
  ["a session's", prepareSession],
  ["the CLI's", ensurePrivateStateRoot],
] as const;

/** A worktree, and a directory beside it that state setup will make. */
function worktreeBeside(): { base: string; cwd: string; elsewhere: string } {
  const base = tempDir("elwood-state-root-race-");
  fs.mkdirSync(join(base, "worktree"));
  return { base, cwd: join(base, "worktree"), elsewhere: join(base, "elsewhere") };
}

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
  race.now.removing = cwd;
  expect(() => prepareStateDir(join(cwd, "state", "nested"), { cwd })).toThrow(
    expect.objectContaining({ code: "ENOENT" }),
  );
  expect(race.now.resolutions).toBe(2);
  expect(fs.existsSync(cwd), "the worktree must not be recreated").toBe(false);
});

test.skipIf(!tmpFoldsCase())(
  "C-STATE-14 a cwd removed once resolved fails a stateDir spelled in another case",
  () => {
    const cwd = join(tempDir("elwood-state-root-race-"), "Worktree");
    fs.mkdirSync(cwd);
    race.now.removing = cwd;
    race.now.at = 1; // the root's own resolution reaches `cwd` through its other spelling
    const stateDir = join(dirname(cwd), "worktree", "state", "nested");
    expect(() => prepareStateDir(stateDir, { cwd })).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
    expect(race.now.resolutions).toBe(1);
    expect(fs.existsSync(cwd), "the worktree must not be recreated").toBe(false);
  },
);

test.each(
  stateSetups,
)("C-STATE-14 C-CLI-15 %s stateDir elsewhere, made as its cwd goes, is removed again", (_setup, prepare) => {
  const { base, cwd } = worktreeBeside();
  const kept = join(base, "kept"); // there before, and holding something of its own
  fs.mkdirSync(kept);
  fs.writeFileSync(join(kept, "sentinel"), "");
  race.now.removing = cwd;
  race.now.at = 1; // once the root is resolved, before anything is made
  expect(() => prepare(join(kept, "made", "state"), cwd)).toThrow(
    expect.objectContaining({ code: "ENOENT" }),
  );
  expect(race.now.resolutions).toBe(1);
  expect(fs.existsSync(join(kept, "made")), "the state directory must not outlive the start").toBe(
    false,
  );
  expect(fs.readdirSync(kept), "what was there before stays").toEqual(["sentinel"]);
  expect(fs.existsSync(cwd), "the worktree must not be recreated").toBe(false);
});

test.each(
  stateSetups,
)("C-STATE-14 %s undo keeps the start's own failure when a directory it made is already gone", (_setup, prepare) => {
  const { cwd, elsewhere } = worktreeBeside();
  const stateDir = join(elsewhere, "state");
  Object.assign(race.now, { removing: cwd, early: true }); // as it is checked again, once made
  race.now.meanwhile = () => fs.rmSync(join(stateDir, "sessions"), { recursive: true });
  expect(() => prepare(stateDir, cwd)).toThrow(
    expect.objectContaining({ code: "ENOENT", syscall: "realpath", path: cwd }),
  );
  expect(fs.existsSync(elsewhere), "the rest is still removed").toBe(false);
});

// Root may remove an entry from a directory it can't write, so only another user sees EACCES.
describe.skipIf(process.getuid?.() === 0)("as a user other than root", () => {
  test.each(
    stateSetups,
  )("C-STATE-14 C-API-61 %s undo that can't remove a directory reports it with the start's failure", async (_setup, prepare) => {
    const { cwd, elsewhere } = worktreeBeside();
    Object.assign(race.now, { removing: cwd, early: true });
    race.now.meanwhile = () => fs.chmodSync(elsewhere, 0o500); // so `state` can't leave it
    setPlatformForTests("darwin");
    const launch = recheckLaunchDirectoryOnFailure("codex", cwd, async () =>
      prepare(join(elsewhere, "state"), cwd),
    );
    await expect(launch).rejects.toMatchObject({
      code: "codex_start_failed",
      details: { cwd, errno: "ENOENT", syscall: "realpath", cleanupErrorCode: "EACCES" },
    });
    fs.chmodSync(elsewhere, 0o700);
    expect(fs.readdirSync(join(elsewhere, "state")), "what it could remove is gone").toEqual([]);
  });
});

test.each(
  stateSetups,
)("C-STATE-14 %s setup makes again a directory another start's undo removed", (_setup, prepare) => {
  const { cwd, elsewhere } = worktreeBeside();
  const sessions = join(elsewhere, "state", "sessions");
  Object.assign(race.now, { making: sessions, times: 2 }); // twice: the last attempt succeeds
  race.now.before = () => fs.rmSync(elsewhere, { recursive: true });
  prepare(join(elsewhere, "state"), cwd);
  expect(fs.existsSync(sessions)).toBe(true);
});

test("C-STATE-14 setup that keeps losing its directories fails after its last attempt", () => {
  const { cwd, elsewhere } = worktreeBeside();
  Object.assign(race.now, { making: join(elsewhere, "state", "sessions"), times: 3 });
  race.now.before = () => fs.rmSync(elsewhere, { recursive: true });
  expect(() => prepareSession(join(elsewhere, "state"), cwd)).toThrow(
    expect.objectContaining({ code: "ENOENT" }),
  );
  expect(race.now.times).toBe(0);
});

test("C-STATE-14 a start's undo leaves a state root another start has put its session in", () => {
  const { base, cwd, elsewhere } = worktreeBeside();
  const other = join(base, "other-worktree");
  fs.mkdirSync(other);
  const stateDir = join(elsewhere, "state");
  race.now.removing = cwd;
  race.now.at = 1; // the other start runs between this one's resolving `cwd` and its undo
  race.now.meanwhile = () => prepareStateDir(stateDir, { cwd: other, elwoodSessionId: "other" });
  expect(() => prepareStateDir(stateDir, { cwd, elwoodSessionId: "gone" })).toThrow(
    expect.objectContaining({ code: "ENOENT", syscall: "realpath", path: cwd }),
  );
  expect(fs.readdirSync(join(stateDir, "sessions"))).toEqual(["other"]);
  // The other start's launch then makes its session's files inside that directory.
  expect(() => secureMkdir(join(stateDir, "sessions", "other"))).not.toThrow();
});
