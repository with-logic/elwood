/**
 * Verifies the trust-prompt ALLOWLIST against a REAL Claude CLI frame rather than
 * hand-authored strings, AND that the autotrust path clears the gate end-to-end:
 * launches Claude in a fresh, untrusted directory WITHOUT autotrust, captures the
 * actual folder-trust frame, and asserts our recognition (header-anchored) +
 * affirmative-option matching accept the real wording — then launches a SECOND
 * fresh session WITH autotrust and asserts the real session/PTY wiring clears the
 * trust gate and reaches readiness through bounded safe automation.
 * Implements C-E2E-09 for C-CLAUDE-10/C-CLAUDE-14 (§5.1).
 *
 * If the installed CLI does not render a folder-trust prompt (e.g. it auto-trusts
 * a temp dir, or the wording changed), the test SKIPS LOUDLY — it logs the
 * captured terminal so the divergence is visible, and never passes silently.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { optionKeystrokes, selectableOptions } from "../../src/core/terminal-options.ts";
import { TrustPromptResponder } from "../../src/core/trust/responder.ts";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { claudeComposer } from "../fixtures/trust-composer.ts";
import { cleanup, makeProject, skipIf, skipNow, skipReason, waitFor } from "./helpers.ts";
import { completeFolderTrustScreenVisible, folderTrustScreenVisible } from "./trust-screens.ts";

/**
 * Answers `frame` under autotrust and returns the affirmative input written by the
 * responder, or undefined if it is not a recognized workspace-trust frame. The
 * write callback is REAL (not a no-op): we assert the affirmative keystroke it
 * received, proving the responder both recognizes the frame AND emits input.
 */
async function trustInputFor(frame: string): Promise<string | undefined> {
  const responder = new TrustPromptResponder("claude", true);
  const written: string[] = [];
  let rendered = frame;
  const result = responder.handle(
    frame,
    (input) => {
      written.push(input);
      rendered = advancePromptFrame(rendered, input);
    },
    () => rendered,
  );
  if (result?.kind !== "attempted" || result.automation.prompt !== "workspace_trust") {
    responder.dispose();
    return undefined;
  }
  try {
    if ((await result.settled) !== "answered")
      throw new Error("Native trust attempt did not clear");
    return written.join("");
  } finally {
    responder.dispose();
  }
}

/** The raw PTY keys needed to select the real frame's affirmative option, if any. */
function affirmativeOptionKeys(frame: string): string | undefined {
  const option = selectableOptions(frame).find((candidate) =>
    /\byes\b|proceed|trust/i.test(candidate.label),
  );
  return option === undefined ? undefined : optionKeystrokes(option).join("");
}

/** Minimal repaint model for the direct responder check; live wiring is tested below. */
function advancePromptFrame(frame: string, input: string): string {
  if (input === "\r" || /^\d+\r$/.test(input)) return claudeComposer;
  const lines = frame.split("\n");
  const selectedRow = lines.findIndex((line) => /^(\s*)[❯›]\s+/.test(line));
  if (selectedRow < 0) return frame;
  const selected = /^(\s*)[❯›](\s+)(.*)$/.exec(lines[selectedRow] as string);
  if (selected === null) return frame;
  const targetRow = selectedRow + (input === "\u001b[A" ? -1 : 1);
  const target = lines[targetRow];
  if (target === undefined) return frame;
  const labelColumn = (selected[1] as string).length + 1 + (selected[2] as string).length;
  lines[selectedRow] = `${" ".repeat(labelColumn)}${selected[3] as string}`;
  lines[targetRow] = `${selected[1] as string}❯${selected[2] as string}${target.trim()}`;
  return lines.join("\n");
}

/** An answerable real trust frame, an auto-trusted "ready", or no matchable frame. */
type Capture =
  | { readonly kind: "answerable"; readonly frame: string }
  | { readonly kind: "ready" }
  | { readonly kind: "unmatched" };

/**
 * Capture the real folder-trust frame once it is ANSWERABLE (its affirmative
 * option has painted), or "ready" if the CLI reached ready first (auto-trusted).
 * A bare trust HEADER paints before its options, so we keep waiting until the
 * responder can actually answer — otherwise we'd capture a partial frame that
 * is "option_pending" (options not yet rendered) and mistake it for a wording
 * mismatch. On timeout (a trust-ish frame that never became answerable, or wording
 * we don't recognize) we return "unmatched" so the caller SKIPS LOUDLY rather than
 * failing — the point of C-E2E-09 is to catch drift, not to be brittle.
 */
async function captureTrustFrame(session: ClaudeSessionApi): Promise<Capture> {
  try {
    return await waitFor(
      async () => {
        const text = session.terminal.snapshot().text;
        if ((await trustInputFor(text)) !== undefined)
          return { kind: "answerable", frame: text } as const;
        if (completeFolderTrustScreenVisible(text)) {
          throw new Error(
            `Claude rendered a complete but unanswerable folder-trust frame:\n${text}`,
          );
        }
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
  skip: skipIf(skipReason("claude")),
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
      // A REAL skip (not a silent pass; a failure under ELWOOD_E2E_REQUIRE=1): surface
      // what the CLI rendered so the allowlist can be re-verified against it.
      skipNow(
        t,
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
    const input = await trustInputFor(capture.frame);
    const expected = affirmativeOptionKeys(capture.frame);
    assert.ok(expected, "the captured frame renders an affirmative option");
    assert.equal(input, expected, "responder selects the real affirmative option");
  } finally {
    await cleanup(captureSession);
  }

  // The direct-responder check above cannot prove the LIVE autotrust wiring
  // (session start → PTY submission → readiness transition) actually clears the
  // gate. So drive a SECOND fresh, untrusted session WITH autotrust and assert it
  // reaches readiness through the bounded safe trust coordinator.
  const trusted = makeProject("claude");
  let autoSession: ClaudeSessionApi | undefined;
  try {
    autoSession = await startClaude({
      cwd: trusted.cwd,
      stateDir: trusted.stateDir,
      autotrust: true,
    });
    await waitFor(
      () => {
        if (autoSession?.status !== "ready") return undefined;
        return folderTrustScreenVisible(autoSession.terminal.snapshot().text) ? undefined : true;
      },
      "autotrust session clears the visible trust gate before reaching ready",
      120_000,
    );
    assert.equal(autoSession.status, "ready", "autotrust cleared the real folder-trust gate");
    assert.equal(
      folderTrustScreenVisible(autoSession.terminal.snapshot().text),
      false,
      "ready never masks a still-visible folder-trust gate",
    );
  } finally {
    await cleanup(autoSession);
  }
});
