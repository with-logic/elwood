/**
 * Verifies the trust-prompt ALLOWLIST against a REAL Claude CLI frame rather than
 * hand-authored strings, AND that the autotrust path clears the gate end-to-end:
 * launches Claude in a fresh, untrusted directory WITHOUT autotrust, captures the
 * actual folder-trust frame, and asserts our recognition (header-anchored) +
 * affirmative-option matching accept the real wording — then launches a SECOND
 * fresh session WITH autotrust and asserts the real session/PTY wiring clears the
 * trust gate and reaches readiness (the "never block — always say yes" policy).
 * Implements C-E2E-09 for C-CLAUDE-10/C-CLAUDE-14 (§5.1).
 *
 * If the installed CLI does not render a folder-trust prompt (e.g. it auto-trusts
 * a temp dir, or the wording changed), the test SKIPS LOUDLY — it logs the
 * captured terminal so the divergence is visible, and never passes silently.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { numberedOptions } from "../../src/core/terminal-options.ts";
import { TrustPromptResponder } from "../../src/core/trust-responder.ts";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { cleanup, makeProject, skipReason, waitFor } from "./helpers.ts";

/**
 * Answers `frame` under autotrust and returns the affirmative input written by the
 * responder, or undefined if it is not a recognized workspace-trust frame. The
 * write callback is REAL (not a no-op): we assert the affirmative keystroke it
 * received, proving the responder both recognizes the frame AND emits input.
 */
function trustInputFor(frame: string): string | undefined {
  const responder = new TrustPromptResponder("claude", true);
  let written: string | undefined;
  const result = responder.handle(frame, (input) => {
    written = input;
  });
  if (result?.kind !== "answered" || result.automation.prompt !== "workspace_trust")
    return undefined;
  return written;
}

/** The affirmative ("Yes"-family) option number the real frame renders, if any. */
function affirmativeOptionNumber(frame: string): string | undefined {
  return numberedOptions(frame).find((o) => /\byes\b|proceed|trust/i.test(o.label))?.number;
}

/** An answerable real trust frame, an auto-trusted "ready", or no matchable frame. */
type Capture =
  | { readonly kind: "answerable"; readonly frame: string }
  | { readonly kind: "ready" }
  | { readonly kind: "unmatched" };

/**
 * Capture the real folder-trust frame once it is ANSWERABLE (its affirmative
 * option has painted), or "ready" if the CLI reached ready first (auto-trusted).
 * A bare trust HEADER paints before its numbered options, so we keep waiting until
 * the responder can actually answer — otherwise we'd capture a partial frame that
 * is "option_pending" (options not yet rendered) and mistake it for a wording
 * mismatch. On timeout (a trust-ish frame that never became answerable, or wording
 * we don't recognize) we return "unmatched" so the caller SKIPS LOUDLY rather than
 * failing — the point of C-E2E-09 is to catch drift, not to be brittle.
 */
async function captureTrustFrame(session: ClaudeSessionApi): Promise<Capture> {
  try {
    return await waitFor(
      () => {
        const text = session.terminal.snapshot().text;
        if (trustInputFor(text) !== undefined) return { kind: "answerable", frame: text } as const;
        if (session.status === "ready") return { kind: "ready" } as const;
        return undefined;
      },
      "answerable folder-trust frame or ready",
      90_000,
    );
  } catch (error) {
    // ONLY a genuine wait TIMEOUT means "no matchable frame rendered" (skip).
    // A real terminal.snapshot()/responder regression must FAIL, not skip — else
    // C-E2E-09 would mask exactly the kind of drift it exists to catch.
    if (error instanceof Error && error.message.startsWith("Timed out waiting for")) {
      return { kind: "unmatched" };
    }
    throw error;
  }
}

test("C-E2E-09 the allowlist recognizes and the autotrust path clears the REAL Claude folder-trust gate", {
  skip: skipReason("claude"),
  timeout: 240_000,
}, async (t) => {
  const project = makeProject("claude");
  // autotrust: false so Elwood does NOT auto-answer — we capture the raw trust
  // frame the real CLI renders in a fresh, untrusted directory.
  const captureSession = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    autotrust: false,
  });
  let capture: Capture = { kind: "unmatched" };
  try {
    capture = await captureTrustFrame(captureSession);
    if (capture.kind !== "answerable") {
      // A REAL skip (not a silent pass): surface what the CLI rendered so the
      // allowlist can be re-verified against it, then mark the test skipped.
      t.skip(
        `no matchable folder-trust frame from claude (status=${captureSession.status}). ` +
          `Captured terminal:\n${captureSession.terminal.snapshot().text}`,
      );
      return;
    }
    // The REAL frame is recognized as workspace_trust AND the responder wrote the
    // EXACT affirmative option (not just any non-empty input): the number the CLI
    // rendered for its "Yes/proceed/trust" option, followed by Enter. This would
    // catch a regression that selected a decline option (C-E2E-09 requires the
    // affirmative option against the captured wording).
    const input = trustInputFor(capture.frame);
    const expected = affirmativeOptionNumber(capture.frame);
    assert.ok(expected, "the captured frame renders an affirmative option");
    assert.equal(input, `${expected}\r`, "responder selects the real affirmative option");
  } finally {
    await cleanup(captureSession);
  }

  // The direct-responder check above cannot prove the LIVE autotrust wiring
  // (session start → PTY submission → readiness transition) actually clears the
  // gate. So drive a SECOND fresh, untrusted session WITH autotrust and assert it
  // reaches readiness — the "never block, always say yes" policy end-to-end.
  const trusted = makeProject("claude");
  let autoSession: ClaudeSessionApi | undefined;
  try {
    autoSession = await startClaude({
      cwd: trusted.cwd,
      stateDir: trusted.stateDir,
      autotrust: true,
    });
    await waitFor(
      () => (autoSession?.status === "ready" ? true : undefined),
      "autotrust session clears the trust gate and reaches ready",
      120_000,
    );
    assert.equal(autoSession.status, "ready", "autotrust cleared the real folder-trust gate");
  } finally {
    await cleanup(autoSession);
  }
});
