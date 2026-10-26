/**
 * Shared Vitest preload (`setupFiles`): resets the runtime test seams — command
 * runner, PTY factory, platform, and probe timeout — after EVERY test, so a suite
 * that installs a fake can never leak it into a later test, even when it fails
 * before reaching its own reset.
 *
 * It also gives each test file a private `HOME`, with `CODEX_HOME` at its `.codex`, so
 * code that resolves the user's home (a Codex launch's reported `HOME`, and anything built
 * on `homedir()`) cannot read or write the developer's own `~/.codex`, even in a test that
 * unsets `CODEX_HOME`. The prefix does not start with `elwood-`, which socket homes use
 * (`src/state/socket-home.ts`).
 *
 * And every test starts with autoupdates refused until it sets an update coordinator of its
 * own: the update module is reset when it loads, and a re-import after `vi.resetModules()` gets
 * that same module; it is reset again after every test. The production coordinator's lease root
 * comes from the passwd database, not `HOME`, so the private `HOME` alone would not keep a test
 * out of the developer's real one. The preload never loads the update module itself: it loads
 * when a test file first imports it, after that file's own mocks, so a file that mocks
 * `node:os` or `node:fs/promises` still reaches the update lease with them.
 */

import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, vi } from "vitest";
import { resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import { privateTempDir } from "./private-temp.ts";

// Recorded by a worker's first test file, before any preload has replaced HOME/CODEX_HOME.
const userCodexHomeKey = "ELWOOD_TEST_USER_CODEX_HOME";
const userCodexHome =
  process.env[userCodexHomeKey] ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
process.env[userCodexHomeKey] = userCodexHome;
const home = privateTempDir("elwood_test_home-", userCodexHome);
mkdirSync(join(home, ".codex"));
process.env["HOME"] = home;
process.env["CODEX_HOME"] = join(home, ".codex");

/** The update module, once a test file has loaded it. */
const update = vi.hoisted(() => ({
  module: undefined as undefined | { resetAutoupdateForTests(): void },
}));

vi.mock("../../src/runtime/update/once.ts", async (importOriginal) => {
  const once = await importOriginal<typeof import("../../src/runtime/update/once.ts")>();
  once.resetAutoupdateForTests();
  update.module = once;
  return once;
});

afterEach(() => {
  resetRuntimeSeamsForTests();
  update.module?.resetAutoupdateForTests();
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
