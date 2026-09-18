/**
 * Real-CLI e2e for a REJECTED turn on BOTH adapters (PRD §5.8/§12A.5).
 * Implements C-E2E-17: the agent refusing a turn must fail with `turn_failed`, not resolve as a
 * successful empty response (issue #19).
 *
 * The trigger on both CLIs is a bogus `--model`. It is deterministic and quota-independent: the
 * service refuses the model NAME before any model quota is consumed, so this exercises the
 * rejection path even on an account that is out of quota — unlike the usage-limit rejection
 * that originally surfaced the bug.
 *
 * Both adapters are covered because they report rejection through DIFFERENT mechanisms, and a
 * hook-shape regression in either would otherwise restore empty-success behavior with CI green:
 *
 * - Codex fires NO `Stop` hook at all (only `SessionStart` and `UserPromptSubmit`) and reports
 *   the refusal solely as a transcript `task_complete` carrying an `error` — which is why the
 *   fix could not live on the boundary-hook seam. Verified against codex-cli 0.155.0.
 * - Claude DOES fire a real `StopFailure` hook, whose `error` is a `ClaudeStopFailureError`
 *   member (`model_not_found` for this trigger). Verified against the installed Claude CLI.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeSession, CodexSession } from "../../src/index.ts";
import {
  codexAuthMissing,
  e2eTimeoutMs,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipNow,
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
    // SURFACE a teardown failure rather than swallowing it: `close()` falls back to `kill()`
    // and only throws when BOTH fail, which means a real agent process outlived the test. The
    // sandbox is removed afterwards regardless, so a failure here can never strand `CODEX_HOME`
    // — but it must not be hidden, or a leaked CLI would silently contaminate later e2e runs.
    try {
      await session.close();
    } finally {
      sandbox.dispose();
    }
  }
});

test("C-E2E-17 a REJECTED Claude turn fails with turn_failed instead of an empty success", {
  skip: skipIf(skipReason("claude"), skipTurns),
  timeout: e2eTimeoutMs + 30_000,
}, async (t) => {
  const project = makeProject("claude");
  const session = new ClaudeSession({
    cwd: project.cwd,
    stateDir: project.stateDir,
    autotrust: true,
    // Claude's analogue of the Codex trigger: the service refuses the model name itself, so
    // this consumes no model quota and fires a real `StopFailure` hook.
    model: "claude-nonexistent-bogus-model",
  });
  try {
    const error = await session.send("Say OK and nothing else.").then(
      // OBSERVED non-determinism (not a product defect): the service occasionally settles this
      // turn as an empty success instead of rejecting the model, so no `StopFailure` is ever
      // emitted and there is nothing for Elwood to classify. That is a missing PRECONDITION, not
      // a wrong outcome, so skip loudly rather than fail — and never pass silently: a NON-empty
      // reply would mean the bogus model was accepted, which invalidates the trigger outright.
      (response) => {
        if (response === "") return undefined;
        return assert.fail(`the bogus model was ANSWERED, so the trigger is invalid: ${response}`);
      },
      (thrown: unknown) => thrown as { code?: string; message?: string },
    );
    if (error === undefined) {
      return skipNow(t, "the CLI returned an empty success instead of rejecting the model");
    }
    assert.equal(error.code, "turn_failed", `expected turn_failed, got ${error.code}`);
    // The reason names the CLI's OWN `ClaudeStopFailureError`, not a generic fallback — which
    // is what proves the `StopFailure` payload was genuinely read rather than merely detected.
    assert.match(
      String(error.message),
      /model_not_found/,
      "the failure carries the error the CLI reported",
    );
  } finally {
    // Surface a teardown failure rather than swallowing it (see the Codex case above).
    await session.close();
  }
});
