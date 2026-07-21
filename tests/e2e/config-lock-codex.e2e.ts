/**
 * Real-CLI verification that two concurrent Codex sessions switching models do NOT
 * cross-persist a model as the user's global default (PRD C-CODEX-14, findings
 * #3/#14). The process-wide config lock must serialize each session's
 * snapshot→apply→compare-and-swap-restore over the shared ~/.codex/config.toml so
 * the user's prior default is restored regardless of interleaving. The happy-path
 * single-session restore is covered by model-picker.e2e.ts; this pins the lock.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type CodexSession, startCodex } from "../../src/index.ts";
import { cleanup, makeProject, skipReason, waitFor } from "./helpers.ts";

const configPath = join(homedir(), ".codex", "config.toml");

/** The user's root model defaults, which must survive concurrent session switches. */
function rootModelKeys(): readonly string[] {
  const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  return text.split("\n").filter((line) => /^(model|model_reasoning_effort)\s*=/.test(line));
}

async function startReady(): Promise<CodexSession> {
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
  skip: skipReason("codex"),
  timeout: 240_000,
}, async () => {
  const configBefore = existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined;
  const defaultsBefore = rootModelKeys();
  let a: CodexSession | undefined;
  let b: CodexSession | undefined;
  try {
    [a, b] = await Promise.all([startReady(), startReady()]);
    const models = await a.listModels();
    const target = models.find((model) => !model.isCurrent);
    assert.ok(target, "another model is available to switch to");
    // Switch BOTH sessions to the same non-default model at once. Without the
    // process-wide config lock the two snapshot/restore transactions interleave on
    // the shared config.toml and can leave `target` persisted as the user default.
    await Promise.all([a.setModel(target.id), b.setModel(target.id)]);
    // Each session keeps its session-scoped switch...
    assert.equal((await a.listModels()).find((m) => m.isCurrent)?.id, target.id, "A switched");
    assert.equal((await b.listModels()).find((m) => m.isCurrent)?.id, target.id, "B switched");
    // ...but the user's GLOBAL default on disk is restored to what it was before.
    assert.deepEqual(
      rootModelKeys(),
      defaultsBefore,
      "the user's config.toml model default is restored despite concurrent switches",
    );
  } finally {
    if (configBefore !== undefined) writeFileSync(configPath, configBefore);
    await cleanup(a);
    await cleanup(b);
  }
});
