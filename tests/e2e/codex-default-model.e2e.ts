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
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { defaultIds, drawnCodexDefault } from "./codex-default.ts";
import {
  cleanup,
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
  waitFor,
} from "./helpers.ts";

// Launch, readiness, and two picker listings, each of which boots no further process.
const testTimeoutMs = 150_000;
// Codex fires SessionStart within seconds of launch; a minute without it is a failure.
const readyTimeoutMs = 60_000;

test("C-API-23 real Codex marks the configured default model, independent of the current one", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: testTimeoutMs,
}, async () => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, 'model_reasoning_effort = "medium"\n');
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
    await waitFor(
      () => (session?.status === "ready" ? true : undefined),
      "codex ready",
      readyTimeoutMs,
    );
    const unconfigured = await session.listModels();
    const current = unconfigured.find((model) => model.isCurrent);
    assert.ok(current, "the launch model is current");
    // The config names no model, so a default here is one Codex drew (none on 0.164).
    const drawn = drawnCodexDefault(unconfigured);
    const configured = unconfigured.find((model) => !model.isCurrent && model.id !== drawn);
    assert.ok(configured, "another model is listed");
    // Root keys precede every table, so the new key goes first; Codex's boot-time
    // bookkeeping below it is kept.
    const config = readFileSync(sandbox.configPath, "utf8");
    writeFileSync(sandbox.configPath, `model = "${configured.id}"\n${config}`);
    const listed = await session.listModels();
    assert.equal(listed.find((model) => model.isCurrent)?.id, current.id, "session model kept");
    // The markerless layout reports the configured row; a drawn marker outranks it.
    assert.deepEqual(defaultIds(listed), [drawn ?? configured.id]);
  } finally {
    await cleanup(session);
    sandbox.dispose();
  }
});
