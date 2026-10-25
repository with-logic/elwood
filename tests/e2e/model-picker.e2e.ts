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
} from "../../src/index.ts";
import {
  claudePickerRowCount,
  hasCompletePickerOrder,
  readClaudePicker,
  savedClaudeModel,
} from "./claude-picker-oracle.ts";
import { configureCodexDefaultModel, defaultIds, drawnCodexDefault } from "./codex-default.ts";
import { startReadyCodex } from "./codex-ready.ts";
import {
  cleanup,
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
  waitFor,
} from "./helpers.ts";

// Let the installed CLI select its current default. A pinned legacy model can
// disappear from the rendered catalog, leaving every visible isCurrent false.
const BASELINE_CONFIG = 'model_reasoning_effort = "medium"\n';

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
    assert.ok(hasCompletePickerOrder(models), "every row, none missing, in picker order");
    // Claude paints the picker over its slash-command menu; a list read mid-paint is short.
    assert.deepEqual(await session.listModels(), models, "an unchanged picker lists the same rows");
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
    // The last row, so the cursor crosses every row's effort control. Past the ten-row window it
    // stays hidden until the walk reaches it, and the next picker opens scrolled to it.
    const last = after.at(-1);
    assert.ok(last && !last.isCurrent, "the last row is another model");
    assert.ok(after.length > 10, "the picker windows a list of more than ten models");
    await session.setModel(last.id);
    const shown = await readClaudePicker(session);
    assert.ok(shown.effortRow, "the picker shows the current model's effort");
    const saved = savedClaudeModel();
    const final = await session.listModels();
    assert.equal(savedClaudeModel(), saved, "the walking listing saves no default model");
    assert.equal(final.find((model) => model.isCurrent)?.id, last.id);
    // Opened scrolled on its last row, the picker hides the rows ABOVE its window instead.
    assert.deepEqual(
      final.map((model) => model.id),
      models.map((model) => model.id),
      "a picker opened scrolled lists the complete catalog",
    );
    // The walk's arrows move only the highlight; its Escape keeps the model AND its effort.
    const reread = await readClaudePicker(session);
    assert.equal(reread.effortRow, shown.effortRow, "listing keeps the current effort");
    assert.equal(models.length, reread.rowCount, "every row the picker lists");
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
  let session: CodexSessionApi | undefined;
  try {
    session = await startReadyCodex(project);
    const models = await session.listModels();
    assert.ok(models.length >= 3, "picker lists several models");
    assert.equal(models.filter((model) => model.isCurrent).length, 1);
    // The baseline names no model, so a default here is one Codex drew (none on 0.164).
    // Without one, the default is the configured model (§5.3): name one that is neither
    // the launch model nor the switch target.
    const drawn = drawnCodexDefault(models);
    const configured = models.find((model) => !model.isCurrent && model.id !== drawn);
    const target = models.findLast((model) => !model.isCurrent);
    assert.ok(configured && target && configured !== target, "two other models are listed");
    configureCodexDefaultModel(sandbox.configPath, configured.id);
    const defaultsBefore = rootModelKeys(sandbox.configPath);
    await session.setModel(target.id);
    const after = await session.listModels();
    assert.equal(after.find((model) => model.isCurrent)?.id, target.id, "session keeps the switch");
    assert.deepEqual(
      defaultIds(after),
      [drawn ?? configured.id],
      "codex default model is unchanged",
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
  assert.equal(models.length, await claudePickerRowCount(project), "every row the picker counts");
  assert.ok(hasCompletePickerOrder(models), "every row, none missing, in picker order");
  // A probe that read the picker mid-paint returned one row, or none, in 3 of 5 runs.
  for (let probe = 0; probe < 2; probe += 1)
    assert.deepEqual(
      await listClaudeModels({ cwd: project.cwd, stateDir: project.stateDir }),
      models,
      "every probe of the same account lists the same rows",
    );
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
    // The baseline names no model, so at most the one default Codex drew (§5.3).
    drawnCodexDefault(models);
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
