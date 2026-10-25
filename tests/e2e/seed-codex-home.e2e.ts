/**
 * `seedCodexHome` writes a private Codex home wherever its caller names it, so a test can
 * hand Codex a home through a login shell rather than through Elwood's environment. Covers
 * the sandboxed-`CODEX_HOME` setup the real-Codex e2e tests rely on (PRD §12, C-E2E-04).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexAuthMissing, seedCodexHome } from "./scratch.ts";

test("C-E2E-04 seedCodexHome seeds the Codex home its caller names", {
  skip: codexAuthMissing() ?? false,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "elwood_seed_home-"));
  try {
    const home = join(root, "nested", "custom-home");
    const config = 'model = "gpt-6-astra"\n';
    const configPath = seedCodexHome(home, config);
    assert.equal(configPath, join(home, "config.toml"));
    assert.equal(readFileSync(configPath, "utf8"), config);
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, "auth.json")).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
