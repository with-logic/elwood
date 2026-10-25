/**
 * The shared `startReadyCodex` e2e helper tears down a real Codex session that never becomes
 * ready, since its caller never receives that session, and rejects with the readiness failure
 * as the cause. Implements C-E2E-03's teardown of Elwood-owned state for the helper's failure
 * path.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { CodexSessionApi } from "../../src/index.ts";
import { startReadyCodex } from "./codex-ready.ts";
import {
  cleanup,
  codexAuthMissing,
  makeProject,
  pathRemoved,
  sandboxedCodexHome,
  skipIf,
  skipReason,
} from "./helpers.ts";

test("C-E2E-03 startReadyCodex tears down a Codex session that never becomes ready", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: 60_000,
}, async () => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, 'model_reasoning_effort = "medium"\n');
  let started: CodexSessionApi | undefined;
  try {
    // A zero readiness budget gives up before Codex's SessionStart can arrive.
    const failure = await startReadyCodex(project, {
      readyTimeoutMs: 0,
      onStarted: (session) => {
        started = session;
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(failure instanceof Error, "the start rejects");
    assert.match(failure.message, /^codex did not become ready \(status /);
    assert.ok(failure.cause instanceof Error, "the readiness failure is the cause");
    assert.ok(started, "the session started");
    assert.equal(started.status, "torn_down");
    assert.equal(pathRemoved(project.sessionDir(started.elwoodSessionId)), true);
  } finally {
    await cleanup(started);
    sandbox.dispose();
  }
});
