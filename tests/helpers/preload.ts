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
 */

import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";
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

afterEach(() => {
  resetRuntimeSeamsForTests();
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
