/**
 * The Codex config lock is per canonical config FILE (PRD §5.3 setModel restore, C-CODEX-14):
 * different files never wait on each other, every path naming one file shares its lock, even
 * before the file exists, and a file's entry is dropped once it is idle.
 */

import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, test } from "vitest";
import { codexConfigLocksForTests, withCodexConfigLock } from "../../src/codex/config/lock.ts";
import { tempDir } from "../helpers/tmp.ts";

/** Holds the lock for `path` until `release`; `entered` settles once it has the lock. */
function hold(path: string) {
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const done = withCodexConfigLock(path, async () => {
    entered.resolve();
    await held.promise;
  });
  return { entered: entered.promise, release: held.resolve, done };
}

/**
 * Whether a task on `path` runs while `holder` still holds its own lock; `whileHeld` runs after
 * the holder takes the lock and before the task asks for it.
 */
async function runsWhileHeld(
  holder: string,
  path: string,
  whileHeld: () => void = () => undefined,
): Promise<boolean> {
  const holding = hold(holder);
  await holding.entered;
  whileHeld();
  let ran = false;
  const task = withCodexConfigLock(path, () => {
    ran = true;
    return Promise.resolve();
  });
  await setImmediate();
  const result = ran;
  holding.release();
  await Promise.all([holding.done, task]);
  return result;
}

function home(root: string, name: string, config?: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (config !== undefined) writeFileSync(join(dir, "config.toml"), config);
  return dir;
}

test("C-CODEX-14 a switch on one config file never waits for another file's transaction", async () => {
  const root = tempDir();
  const first = join(home(root, "first", ""), "config.toml");
  const second = join(home(root, "second", ""), "config.toml");
  expect(await runsWhileHeld(first, second)).toBe(true);
  expect(await runsWhileHeld(first, first)).toBe(false);
});

test("C-CODEX-14 a symlinked home or config shares the lock of the file it names", async () => {
  const root = tempDir();
  const real = home(root, "real", "");
  symlinkSync(real, join(root, "linked-home"));
  const other = home(root, "other");
  symlinkSync(join(real, "config.toml"), join(other, "config.toml"));
  const config = join(real, "config.toml");
  expect(await runsWhileHeld(config, join(root, "linked-home", "config.toml"))).toBe(false);
  expect(await runsWhileHeld(config, join(other, "config.toml"))).toBe(false);
});

test("C-CODEX-14 a config Codex has not created yet is locked by its home's real path", async () => {
  const root = tempDir();
  const real = home(root, "real");
  symlinkSync(real, join(root, "linked-home"));
  const config = join(real, "config.toml");
  expect(await runsWhileHeld(config, join(root, "linked-home", "config.toml"))).toBe(false);
  expect(await runsWhileHeld(config, join(home(root, "elsewhere"), "config.toml"))).toBe(true);
});

test("C-CODEX-14 a dangling symlink shares the lock of the config it will create", async () => {
  const root = tempDir();
  const config = join(home(root, "real"), "config.toml");
  symlinkSync(config, join(home(root, "absolute"), "config.toml"));
  symlinkSync("../real/config.toml", join(home(root, "relative"), "config.toml"));
  // A chain: the link names a link that names the config.
  symlinkSync(join(root, "relative", "config.toml"), join(home(root, "chained"), "config.toml"));
  for (const name of ["absolute", "relative", "chained"])
    expect(await runsWhileHeld(config, join(root, name, "config.toml")), name).toBe(false);
  expect(await runsWhileHeld(config, join(home(root, "elsewhere"), "config.toml"))).toBe(true);
});

test("C-CODEX-14 a config path that cannot be resolved rejects without running", async () => {
  const root = tempDir();
  const looped = join(home(root, "home"), "config.toml");
  symlinkSync(looped, looped);
  let ran = false;
  const locking = withCodexConfigLock(looped, () => {
    ran = true;
    return Promise.resolve();
  });
  await expect(locking).rejects.toMatchObject({
    code: "model_automation_failed",
    details: { path: looped, errno: "ELOOP" },
  });
  expect(ran).toBe(false);
  expect(codexConfigLocksForTests()).toBe(0);
});

test("C-CODEX-14 a home that does not exist is locked by its absolute path", async () => {
  const root = tempDir();
  const missing = join(root, "missing", "config.toml");
  expect(await runsWhileHeld(missing, join(root, "missing", "..", "missing", "config.toml"))).toBe(
    false,
  );
  expect(await runsWhileHeld(missing, join(root, "absent", "config.toml"))).toBe(true);
});

test("C-CODEX-14 a path in another letter case shares the lock, whether or not the config exists", async () => {
  const root = tempDir();
  const config = join(home(root, "home"), "config.toml");
  const respelled = join(root, "HOME", "CONFIG.toml");
  expect(await runsWhileHeld(config, respelled), "missing").toBe(false);
  writeFileSync(config, "");
  expect(await runsWhileHeld(config, respelled), "existing").toBe(false);
});

test("C-CODEX-14 a dangling symlink spelled in another case shares the lock of the config it will create", async () => {
  const root = tempDir();
  const real = home(root, "real");
  symlinkSync(join(real, "CONFIG.TOML"), join(home(root, "linked"), "config.toml"));
  expect(await runsWhileHeld(join(real, "config.toml"), join(root, "linked", "config.toml"))).toBe(
    false,
  );
});

test("C-CODEX-14 a lock taken through a dangling symlink still holds once Codex creates the config", async () => {
  for (const via of ["link", "direct"] as const) {
    const root = tempDir();
    const real = home(root, "real");
    const link = join(home(root, "linked"), "config.toml");
    symlinkSync(join(real, "CONFIG.TOML"), link);
    const later = via === "link" ? link : join(real, "config.toml");
    // The switch took the lock while the link dangled; Codex then wrote the config through it.
    expect(await runsWhileHeld(link, later, () => writeFileSync(link, "")), via).toBe(false);
  }
});

test("C-CODEX-14 dangling symlinks to names the volume folds alike share a lock", async () => {
  const root = tempDir();
  const real = home(root, "real");
  // APFS folds case fully: `ß`, `ẞ`, `ss`, and `SS` are one name.
  const links = ["ß", "ẞ", "SS"].map((name, index) => {
    const link = join(home(root, `linked-${index}`), "config.toml");
    symlinkSync(join(real, `${name}.toml`), link);
    return link;
  });
  for (const link of links)
    expect(await runsWhileHeld(join(real, "ss.toml"), link), link).toBe(false);
});

test("C-CODEX-14 two Unicode normalizations of a missing home share a lock", async () => {
  const root = tempDir();
  const composed = join(root, "caf\u00e9", "config.toml");
  expect(await runsWhileHeld(composed, join(root, "cafe\u0301", "config.toml"))).toBe(false);
});

test("C-CODEX-14 a file's lock entry is dropped once no holder or waiter remains", async () => {
  const root = tempDir();
  const config = join(home(root, "home", ""), "config.toml");
  const holding = hold(config);
  await holding.entered;
  const closing = new AbortController();
  const waiter = withCodexConfigLock(config, () => Promise.resolve(), {
    signal: closing.signal,
    error: () => new Error("closed"),
  });
  const failing = withCodexConfigLock(join(root, "other", "config.toml"), () =>
    Promise.reject(new Error("boom")),
  );
  expect(codexConfigLocksForTests()).toBe(2);
  closing.abort();
  await expect(waiter).rejects.toThrow("closed");
  await expect(failing).rejects.toThrow("boom");
  expect(codexConfigLocksForTests()).toBe(1);
  holding.release();
  await holding.done;
  expect(codexConfigLocksForTests()).toBe(0);
});
