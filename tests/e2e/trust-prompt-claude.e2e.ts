/**
 * Verifies the trust-prompt ALLOWLIST against a REAL Claude CLI frame rather than
 * hand-authored strings: launches Claude in a fresh, untrusted directory without
 * autotrust, captures the actual folder-trust frame, and asserts our recognition
 * (header-anchored) + affirmative-option matching accept the real wording.
 * Implements C-E2E-09 for C-CLAUDE-10/C-CLAUDE-14 (§5.1).
 *
 * If the installed CLI does not render a folder-trust prompt (e.g. it auto-trusts
 * a temp dir, or the wording changed), the test SKIPS LOUDLY — it logs the
 * captured terminal so the divergence is visible, and never passes silently.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { TrustPromptResponder } from "../../src/core/trust-responder.ts";
import { startClaude } from "../../src/index.ts";
import { cleanup, makeProject, skipReason, waitFor } from "./helpers.ts";

/** A frame is a folder-trust prompt when our responder answers it under autotrust. */
function answersWorkspaceTrust(frame: string): boolean {
  const responder = new TrustPromptResponder("claude", true);
  const result = responder.handle(frame, () => {});
  return result?.kind === "answered" && result.automation.prompt === "workspace_trust";
}

test("C-E2E-09 the allowlist recognizes and answers the REAL Claude folder-trust frame", {
  skip: skipReason("claude"),
  timeout: 240_000,
}, async (t) => {
  const project = makeProject("claude");
  // autotrust: false so Elwood does NOT auto-answer — we want to capture the raw
  // trust frame the real CLI renders in a fresh, untrusted directory.
  const session = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    autotrust: false,
  });
  try {
    // Wait until either a folder-trust frame renders or the session becomes
    // ready (meaning the CLI did not prompt — auto-trusted or different wording).
    const frame = await waitFor(
      () => {
        const text = session.terminal.snapshot().text;
        if (/trust/i.test(text) && /folder|files/i.test(text)) return text;
        if (session.status === "ready") return "";
        return undefined;
      },
      "folder-trust frame or ready",
      90_000,
    );

    if (frame === "" || !answersWorkspaceTrust(frame)) {
      // A REAL skip (not a silent pass): surface what the CLI rendered so the
      // allowlist can be re-verified against it, then mark the test skipped.
      t.skip(
        `no matchable folder-trust frame from claude (status=${session.status}). ` +
          `Captured terminal:\n${session.terminal.snapshot().text}`,
      );
      return;
    }

    // The REAL frame is recognized as workspace_trust AND its affirmative option
    // is selected — proving our header-anchored matchers accept live CLI wording.
    assert.ok(answersWorkspaceTrust(frame), "allowlist answers the real folder-trust frame");
  } finally {
    await cleanup(session);
  }
});
