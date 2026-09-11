/**
 * Compiled-process coverage for CLI agent auto-detection against the real login
 * shell on this machine. Implements PRD §12A.1/§12A.4 and C-CLI-21: with nothing
 * selecting an agent, `config effective` reports the first of claude/codex that
 * the interactive login shell resolves, with source `auto-detected`, and it
 * never starts an agent.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { skipReason } from "./helpers.ts";

const entryPath = fileURLToPath(new URL("../../dist/cli/entry.js", import.meta.url));

type EffectiveDocument = {
  readonly type: "effective-settings";
  readonly settings: { readonly agent: { readonly value: string; readonly source: string } };
};

test("C-CLI-21 config effective auto-detects the first available real agent", () => {
  const available = (["claude", "codex"] as const).filter((agent) => !skipReason(agent));
  // --no-defaults ignores any saved config or ELWOOD_AGENT on this machine, so
  // nothing selects the agent and the login-shell probe must decide.
  const result = spawnSync(process.execPath, [entryPath, "config", "effective", "--no-defaults"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (available.length === 0) {
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /no agent was found/iu);
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout) as EffectiveDocument;
  assert.equal(document.type, "effective-settings");
  assert.deepEqual(document.settings.agent, { value: available[0], source: "auto-detected" });
});
