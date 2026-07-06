/**
 * Real-agent model listing and session-scoped model switching.
 * Implements C-API-23, C-API-24, C-E2E-02, and C-E2E-03.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ClaudeSession, type CodexSession, startClaude, startCodex } from "../../src/index.ts";
import { cleanup, makeProject, skipReason, waitFor } from "./helpers.ts";

test("C-API-23 C-API-24 real Claude lists models and switches session-only", {
  skip: skipReason("claude"),
  timeout: 150_000,
}, async () => {
  const project = makeProject("claude");
  let session: ClaudeSession | undefined;
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
    assert.ok(models.some((model) => model.id === "haiku"));
    const before = models.find((model) => model.isCurrent);
    assert.notEqual(before?.id, "haiku", "test session does not start on haiku");
    await session.setModel("haiku");
    const after = await session.listModels();
    assert.equal(after.find((model) => model.isCurrent)?.id, "haiku");
    // Session-only apply: the default marker must not have moved to haiku.
    const defaultRow = after.find((model) => model.isDefault);
    assert.notEqual(defaultRow?.id, "haiku", "user default model is untouched");
  } finally {
    await cleanup(session);
  }
});

test("C-API-23 C-API-24 real Codex lists models and switches session-scoped", {
  skip: skipReason("codex"),
  timeout: 150_000,
}, async () => {
  const project = makeProject("codex");
  // The Codex CLI persists picker selections into the user's config.toml
  // (PRD §5.3 deviation note), so snapshot and restore it around this test.
  const configPath = join(homedir(), ".codex", "config.toml");
  const configBefore = existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined;
  let session: CodexSession | undefined;
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
    assert.equal(after.find((model) => model.isCurrent)?.id, target.id);
    assert.equal(
      after.find((model) => model.isDefault)?.id,
      models.find((model) => model.isDefault)?.id,
      "codex default model marker is unchanged",
    );
  } finally {
    if (configBefore !== undefined) writeFileSync(configPath, configBefore);
    await cleanup(session);
  }
});
