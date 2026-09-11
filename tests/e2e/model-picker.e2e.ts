/**
 * Real-agent model listing and session-scoped model switching.
 * Implements C-API-23, C-API-24, C-API-41, C-E2E-02, and C-E2E-03.
 *
 * Codex persists picker selections into `config.toml`, so every Codex test here runs
 * inside a sandboxed `CODEX_HOME` (`sandboxedCodexHome`) seeded with a known baseline:
 * the developer's real `~/.codex/config.toml` is never read, written, or "restored".
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  type ClaudeSessionApi,
  type CodexSessionApi,
  listClaudeModels,
  listCodexModels,
  startClaude,
  startCodex,
} from "../../src/index.ts";
import {
  cleanup,
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
  waitFor,
} from "./helpers.ts";

const BASELINE_CONFIG = 'model = "gpt-5.1-codex"\nmodel_reasoning_effort = "medium"\n';

/** The root model defaults on disk; Codex appends unrelated trust bookkeeping at boot. */
function rootModelKeys(configPath: string): readonly string[] {
  const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  return text.split("\n").filter((line) => /^(model|model_reasoning_effort)\s*=/.test(line));
}

test("C-API-23 C-API-24 real Claude lists models and switches session-only", {
  skip: skipIf(skipReason("claude")),
  timeout: 150_000,
}, async () => {
  const project = makeProject("claude");
  let session: ClaudeSessionApi | undefined;
  try {
    session = await startClaude({
      cwd: project.cwd,
      stateDir: project.stateDir,
      autotrust: true,
      hooks: {},
    });
    await waitFor(() => (session?.status === "ready" ? true : undefined), "claude ready", 60_000);
    const models = await session.listModels();
    assert.ok(models.length >= 3, "picker lists several models");
    assert.equal(models.filter((model) => model.isCurrent).length, 1);
    assert.ok(
      models.some((model) => model.isDefault),
      "a default row is marked",
    );
    // Any non-current model: the roster depends on the developer's account/plan.
    const target = models.find((model) => !model.isCurrent);
    assert.ok(target, "another model is available to switch to");
    await session.setModel(target.id);
    const after = await session.listModels();
    assert.equal(after.find((model) => model.isCurrent)?.id, target.id);
    // Session-only apply: the default marker must not have moved to the target.
    assert.equal(
      after.find((model) => model.isDefault)?.id,
      models.find((model) => model.isDefault)?.id,
      "user default model is untouched",
    );
  } finally {
    await cleanup(session);
  }
});

test("C-API-23 C-API-24 real Codex lists models and switches session-scoped", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: 150_000,
}, async () => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, BASELINE_CONFIG);
  const defaultsBefore = rootModelKeys(sandbox.configPath);
  let session: CodexSessionApi | undefined;
  try {
    session = await startCodex({
      cwd: project.cwd,
      stateDir: project.stateDir,
      sandbox: "read-only",
      approvalPolicy: "never",
      autotrust: true,
      hooks: {},
    });
    await waitFor(() => (session?.status === "ready" ? true : undefined), "codex ready", 60_000);
    const models = await session.listModels();
    assert.ok(models.length >= 2, "picker lists several models");
    assert.equal(models.filter((model) => model.isCurrent).length, 1);
    assert.equal(models.filter((model) => model.isDefault).length, 1);
    const target = models.find((model) => !model.isCurrent);
    assert.ok(target, "another model is available to switch to");
    await session.setModel(target.id);
    const after = await session.listModels();
    assert.equal(after.find((model) => model.isCurrent)?.id, target.id, "session keeps the switch");
    assert.equal(
      after.find((model) => model.isDefault)?.id,
      models.find((model) => model.isDefault)?.id,
      "codex default model marker is unchanged",
    );
    // C-CODEX-14: Elwood itself restored the sandbox's model defaults after the CLI
    // persisted the picker selection — nothing in this test writes them back.
    assert.deepEqual(
      rootModelKeys(sandbox.configPath),
      defaultsBefore,
      "user model defaults already restored by setModel",
    );
  } finally {
    await cleanup(session);
    sandbox.dispose();
  }
});

test("C-API-41 real listClaudeModels returns models without a caller-held session", {
  skip: skipIf(skipReason("claude")),
  timeout: 150_000,
}, async () => {
  const project = makeProject("claude");
  const models = await listClaudeModels({ cwd: project.cwd, stateDir: project.stateDir });
  assert.ok(models.length >= 3, "session-less probe lists several models");
  assert.equal(models.filter((model) => model.isCurrent).length, 1);
  assert.ok(
    models.some((model) => model.isDefault),
    "a default row is marked",
  );
});

test("C-API-41 real listCodexModels returns models and leaves config.toml untouched", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: 150_000,
}, async () => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, BASELINE_CONFIG);
  const defaultsBefore = rootModelKeys(sandbox.configPath);
  try {
    const models = await listCodexModels({ cwd: project.cwd, stateDir: project.stateDir });
    assert.ok(models.length >= 2, "session-less probe lists several models");
    assert.equal(models.filter((model) => model.isCurrent).length, 1);
    assert.equal(models.filter((model) => model.isDefault).length, 1);
    // The probe only opens and cancels the picker (never applies a selection), so
    // the sandbox's model defaults are untouched.
    assert.deepEqual(
      rootModelKeys(sandbox.configPath),
      defaultsBefore,
      "listCodexModels leaves the user's model defaults untouched",
    );
  } finally {
    sandbox.dispose();
  }
});
