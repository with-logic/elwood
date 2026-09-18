/**
 * Real-CLI e2e for a REJECTED Codex turn (PRD §5.8/§12A.5).
 * Implements C-E2E-17: the agent refusing a turn must fail with `turn_failed`, not resolve as a
 * successful empty response (issue #19).
 *
 * The trigger is a bogus `--model`. It is deterministic and quota-independent: the service
 * refuses the model name itself (HTTP 400 `invalid_request_error`) before any model quota is
 * consumed, so this exercises the rejection path even on an account that is out of quota —
 * unlike the usage-limit rejection that originally surfaced the bug.
 *
 * What the real CLI does here, and why the fix could not live on the boundary-hook seam:
 * a rejected Codex turn fires NO `Stop` hook at all (only `SessionStart` and
 * `UserPromptSubmit`), and reports the refusal solely as a transcript `task_complete`
 * carrying an `error`. Verified against codex-cli 0.155.0.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CodexSession } from "../../src/index.ts";
import {
  codexAuthMissing,
  e2eTimeoutMs,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
  skipTurns,
} from "./helpers.ts";

test("C-E2E-17 a REJECTED Codex turn fails with turn_failed instead of an empty success", {
  skip: skipIf(skipReason("codex"), skipTurns, codexAuthMissing()),
  timeout: e2eTimeoutMs + 30_000,
}, async () => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, "");
  const session = new CodexSession({
    cwd: project.cwd,
    stateDir: project.stateDir,
    autotrust: true,
    highTrust: true,
    // A model the service will refuse outright — the rejection needs no model quota.
    model: "gpt-nonexistent-bogus-model",
  });
  try {
    const error = await session.send("Say OK and nothing else.").then(
      (response) =>
        assert.fail(
          `expected the rejected turn to throw; it resolved with ${JSON.stringify(response)}`,
        ),
      (thrown: unknown) => thrown as { code?: string; message?: string },
    );
    // The regression: this used to resolve with "" (and the CLI exited 0).
    assert.equal(error.code, "turn_failed", `expected turn_failed, got ${error.code}`);
    // The reason is the CLI's OWN, unwrapped from its JSON envelope — not a generic message.
    assert.match(
      String(error.message),
      /gpt-nonexistent-bogus-model/,
      "the failure carries the real reason the CLI reported",
    );
  } finally {
    await session.teardown().catch(() => undefined);
    sandbox.dispose();
  }
});
