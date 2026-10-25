/**
 * The child run behind `codex-home-isolation.e2e.ts` (PRD §12, C-E2E-22): one real Codex
 * session built the way the suite builds them, a `makeProject` scratch dir and `startCodex`
 * with autotrust, held until `ready` and torn down. Like most e2e files it imports only the
 * shared helpers, so it gets its Codex home the way they do. The project is a Git
 * repository because that is where Codex 0.164.0 shows its folder-trust gate
 * (docs/cli-behavior.md); answering it makes Codex save a `[projects."<root>"]` entry to
 * its `config.toml`. The run asserts that entry landed in the `CODEX_HOME` the helpers set,
 * so the parent's "the user's home is untouched" check cannot pass because Codex never
 * wrote anything.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
import { startCodex } from "../../src/index.ts";
import { cleanup, makeProject, waitFor } from "./helpers.ts";

test("C-E2E-22 a default Codex e2e session trusts its project inside the suite's Codex home", {
  timeout: 120_000,
}, async () => {
  const codexHome = process.env["CODEX_HOME"];
  assert.ok(codexHome, "the shared e2e helpers set CODEX_HOME");
  const project = makeProject("codex");
  execFileSync("git", ["init", "--quiet"], { cwd: project.cwd });
  const session = await startCodex({
    cwd: project.cwd,
    stateDir: project.stateDir,
    autotrust: true,
  });
  try {
    await waitFor(() => (session.status === "ready" ? true : undefined), "ready", 90_000);
  } finally {
    await cleanup(session);
  }
  const config = join(codexHome, "config.toml");
  const saved = existsSync(config) ? readFileSync(config, "utf8") : "";
  assert.match(saved, new RegExp(`\\[projects\\."[^"]*/${basename(project.cwd)}"\\]`));
});
