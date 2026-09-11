/**
 * Real-CLI verification that two concurrent Codex sessions switching models do NOT
 * cross-persist a model as the user's global default (PRD C-CODEX-14). The config
 * lock must serialize each session's snapshot→apply→compare-and-swap-restore over
 * the shared config.toml so the prior default is restored regardless of interleaving.
 *
 * Safety: this runs entirely inside a SANDBOXED CODEX_HOME seeded with only the
 * user's real auth.json (`sandboxedCodexHome`) — it never reads or writes the real
 * ~/.codex/config.toml, and the sandbox is removed only AFTER both sessions are torn
 * down, so an in-flight session can never rewrite a restored file. The happy-path
 * single-session restore is covered by model-picker.e2e.ts; this pins the lock.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import {
  cleanup,
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
  waitFor,
} from "./helpers.ts";

// A known baseline default the sandbox starts from; concurrent switches must restore it.
const BASELINE_CONFIG = 'model = "gpt-5.1-codex"\nmodel_reasoning_effort = "medium"\n';

/** The root model defaults in the sandbox config, which must survive concurrent switches. */
function rootModelKeys(configPath: string): readonly string[] {
  const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  return text.split("\n").filter((line) => /^(model|model_reasoning_effort)\s*=/.test(line));
}

async function startReady(): Promise<CodexSessionApi> {
  const project = makeProject("codex");
  const session = await startCodex({
    cwd: project.cwd,
    stateDir: project.stateDir,
    sandbox: "read-only",
    approvalPolicy: "never",
    autotrust: true,
    hooks: {},
  });
  await waitFor(() => (session.status === "ready" ? true : undefined), "codex ready", 60_000);
  return session;
}

test("C-CODEX-14 concurrent Codex model switches restore the user default (real CLI)", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: 240_000,
}, async () => {
  const sandbox = sandboxedCodexHome(makeProject("codex"), BASELINE_CONFIG);
  const defaultsBefore = rootModelKeys(sandbox.configPath);
  let a: CodexSessionApi | undefined;
  let b: CodexSessionApi | undefined;
  try {
    [a, b] = await Promise.all([startReady(), startReady()]);
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
  } finally {
    // Tear the sessions down BEFORE removing the sandbox, so an in-flight session can
    // never rewrite the config after we stop watching it. The real ~/.codex is untouched.
    await cleanup(a);
    await cleanup(b);
    sandbox.dispose();
  }
});
