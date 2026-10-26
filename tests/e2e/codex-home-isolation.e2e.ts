/**
 * No real-Codex e2e writes the invoking user's Codex home (PRD §12, C-E2E-22). The guard
 * runs one default Codex session (`codex-home-isolation-run.ts`) as its own `node --test`
 * file, the way a developer runs a single e2e file, with `HOME` pointed at a throwaway
 * and with `CODEX_HOME` unset. To that run the throwaway IS the user's home, so it must
 * come back with the same files, contents, and mtimes. Its `.codex` holds a sentinel
 * `config.toml` and an `auth.json` with a loose mode, which the child checks the suite
 * neither copies nor keeps. The child reports its private `CODEX_HOME`, which must be
 * gone once it exits. The developer's own Codex home is never involved beyond copying
 * `auth.json`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copyCodexAuth } from "./codex-home.ts";
import { codexAuthMissing, skipIf, skipReason } from "./helpers.ts";

const childRun = join(import.meta.dirname, "codex-home-isolation-run.ts");

/** Every entry under `dir`, keyed by relative path, with its mtime and content hash. */
function snapshot(dir: string): ReadonlyMap<string, string> {
  const entries = readdirSync(dir, { recursive: true, encoding: "utf8" }).map((name) => {
    const stat = statSync(join(dir, name));
    if (stat.isDirectory()) return [name, "directory"] as const;
    const digest = createHash("sha256")
      .update(readFileSync(join(dir, name)))
      .digest("hex");
    return [name, `${stat.mtimeMs} ${digest}`] as const;
  });
  return new Map(entries);
}

/** The paths added, removed, or rewritten between two snapshots. */
function changed(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}

test("C-E2E-22 a Codex e2e leaves the user's Codex home untouched", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: 180_000,
}, () => {
  const home = mkdtempSync(join(tmpdir(), "elwood_e2e_user_home-"));
  const report = join(home, "child-codex-home");
  try {
    const userCodexHome = join(home, ".codex");
    mkdirSync(userCodexHome, { mode: 0o700 });
    copyCodexAuth(userCodexHome);
    chmodSync(join(userCodexHome, "auth.json"), 0o644);
    writeFileSync(
      join(userCodexHome, "config.toml"),
      '[projects."/sentinel"]\ntrust_level = "trusted"\n',
    );
    const before = snapshot(userCodexHome);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ELWOOD_E2E_GUARD_REPORT: report };
    // A developer's shell: no CODEX_HOME, and no runner context inherited from this file.
    for (const key of ["CODEX_HOME", "ELWOOD_E2E_USER_CODEX_HOME", "NODE_TEST_CONTEXT"])
      delete env[key];
    // In-process isolation: a timeout's kill reaches the process that owns the Codex PTY.
    const args = ["--no-warnings", "--test", "--test-isolation=none", childRun];
    const run = spawnSync(process.execPath, args, {
      env,
      encoding: "utf8",
      timeout: 160_000,
    });
    const failure = `${run.error?.message ?? ""} signal ${run.signal}\n${run.stdout}\n${run.stderr}`;
    assert.equal(run.status, 0, failure);
    assert.match(run.stdout, /ℹ pass 1\b/);
    assert.deepEqual(changed(before, snapshot(userCodexHome)), [], "the user's Codex home changed");
    assert.equal(
      existsSync(readFileSync(report, "utf8")),
      false,
      "the suite's Codex home remained",
    );
  } finally {
    if (existsSync(report)) rmSync(readFileSync(report, "utf8"), { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
