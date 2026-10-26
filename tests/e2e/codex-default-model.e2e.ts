/**
 * Real Codex reports the configured default model, independent of the session's current one.
 * Implements PRD §5.3 `isDefault` and C-API-23.
 *
 * Codex 0.164 marks only the `(current)` row of its picker, so Elwood reads the default
 * from `config.toml`; older Codex draws its own `(default)` marker, which outranks the
 * config. The session runs in a sandboxed `CODEX_HOME`, and the test names a different
 * configured model between two listings of the same live session.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { CodexSessionApi } from "../../src/index.ts";
import { configureCodexDefaultModel, defaultIds, drawnCodexDefault } from "./codex-default.ts";
import { startReadyCodex } from "./codex-ready.ts";
import { codexLaunches, runCodexTest } from "./codex-test-end.ts";
import {
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
} from "./helpers.ts";

// Launch, readiness, and two picker listings, each of which boots no further process.
const testTimeoutMs = 150_000;

test("C-API-23 real Codex marks the configured default model, independent of the current one", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: testTimeoutMs,
}, async () => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, 'model_reasoning_effort = "medium"\n');
  const launches = codexLaunches();
  const started: CodexSessionApi[] = [];
  await runCodexTest({ sessions: () => started, sandbox, launches }, async () => {
    const session = await startReadyCodex(project, {
      launches,
      onStarted: (launched) => started.push(launched),
    });
    const unconfigured = await session.listModels();
    const current = unconfigured.find((model) => model.isCurrent);
    assert.ok(current, "the launch model is current");
    // The config names no model, so a default here is one Codex drew (none on 0.164).
    const drawn = drawnCodexDefault(unconfigured);
    const configured = unconfigured.find((model) => !model.isCurrent && model.id !== drawn);
    assert.ok(configured, "another model is listed");
    configureCodexDefaultModel(sandbox.configPath, configured.id);
    const listed = await session.listModels();
    assert.equal(listed.find((model) => model.isCurrent)?.id, current.id, "session model kept");
    // The markerless layout reports the configured row; a drawn marker outranks it.
    assert.deepEqual(defaultIds(listed), [drawn ?? configured.id]);
  });
});
