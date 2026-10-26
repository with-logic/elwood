/**
 * Real-CLI verification that two concurrent Codex sessions switching models do NOT
 * cross-persist a model as the user's global default (PRD C-CODEX-14). The config
 * lock must serialize each session's snapshot→apply→compare-and-swap-restore over
 * the shared config.toml so the prior default is restored regardless of interleaving.
 *
 * Safety: this runs entirely inside a SANDBOXED CODEX_HOME seeded with only the
 * user's real auth.json (`sandboxedCodexHome`) — it never reads or writes the real
 * ~/.codex/config.toml, and the sandbox is removed only once both sessions are confirmed
 * torn down, so an in-flight session can never rewrite a restored file. The happy-path
 * single-session restore is covered by model-picker.e2e.ts; this pins the lock.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import type { CodexSessionApi } from "../../src/index.ts";
import { startReadyCodex } from "./codex-ready.ts";
import { codexLaunches, runCodexTest } from "./codex-test-end.ts";
import {
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
} from "./helpers.ts";

// A known baseline default the sandbox starts from; concurrent switches must restore it.
const BASELINE_CONFIG = 'model = "gpt-5.1-codex"\nmodel_reasoning_effort = "medium"\n';

/** The root model defaults in the sandbox config, which must survive concurrent switches. */
function rootModelKeys(configPath: string): readonly string[] {
  const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  return text.split("\n").filter((line) => /^(model|model_reasoning_effort)\s*=/.test(line));
}

test("C-CODEX-14 concurrent Codex model switches restore the user default (real CLI)", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: 240_000,
}, async () => {
  const sandbox = sandboxedCodexHome(makeProject("codex"), BASELINE_CONFIG);
  const otherProjects = [makeProject("codex"), makeProject("codex")] as const;
  const defaultsBefore = rootModelKeys(sandbox.configPath);
  const launches = codexLaunches();
  const started: CodexSessionApi[] = [];
  // Every started session is torn down before the sandbox goes, and the sandbox goes only
  // once each is confirmed gone, so an in-flight session can never rewrite the config after
  // we stop watching it. A session whose start failed was torn down already; this retries
  // it if that failed. The real ~/.codex is untouched.
  await runCodexTest({ sessions: () => started, otherProjects, sandbox, launches }, async () => {
    // Start the sessions one after the other; the concurrency under test is the model
    // switch below. Codex 0.164.0 does not serialize its SQLite migrations across
    // processes, so two cold starts in this fresh sandbox race them and one exits with
    // "local database appears to be damaged" (docs/cli-behavior.md).
    // Each started session is tracked at once, so the test's end covers a failed start
    // whose own cleanup also failed.
    const track = { launches, onStarted: (session: CodexSessionApi) => started.push(session) };
    const a = await startReadyCodex(otherProjects[0], track);
    const b = await startReadyCodex(otherProjects[1], track);
    const models = await a.listModels();
    const target = models.find((model) => !model.isCurrent);
    assert.ok(target, "another model is available to switch to");
    // Switch BOTH sessions to the same non-default model at once. Without the config
    // lock the two snapshot/restore transactions interleave on the shared config.toml
    // and can leave `target` persisted as the default.
    await Promise.all([a.setModel(target.id), b.setModel(target.id)]);
    assert.equal((await a.listModels()).find((m) => m.isCurrent)?.id, target.id, "A switched");
    assert.equal((await b.listModels()).find((m) => m.isCurrent)?.id, target.id, "B switched");
    // The GLOBAL default on disk is restored to the baseline despite concurrent switches.
    assert.deepEqual(
      rootModelKeys(sandbox.configPath),
      defaultsBefore,
      "the config.toml model default is restored despite concurrent switches",
    );
  });
});
