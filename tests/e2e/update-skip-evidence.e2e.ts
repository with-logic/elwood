/**
 * The update-skip key never reaches a prompt that contradicts the captured appearance,
 * exercised through a REAL PTY and the real terminal emulator (C-CODEX-22, issue #50).
 *
 * Why a PTY and not a unit test. The guard reads RENDERED frames, so what it actually
 * sees is whatever the emulator produces after real escape sequences, real wrapping and
 * a real clear-screen — not the string a unit test hands it. Issue #50's three failed
 * attempts all passed their synthetic frames; the frame-splitting behaviour that broke
 * them only shows up once something really renders. This paints the frames through a
 * real shell process on a real 100x40 PTY and asserts at the PTY write boundary.
 *
 * The genuine update screen cannot be summoned on demand (it needs an actually-stale
 * binary, see docs/cli-behavior.md), so the ADVERSARIAL prompts are painted instead —
 * which is the case under test. `codex-native-startup.e2e.ts` covers the real Codex
 * startup path against the live CLI.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  automatedWritesAfterReplacement,
  blockingAcrossReplacement,
  completeUpdatePaint,
} from "./update-skip-harness.ts";

test("C-CODEX-22 a real-PTY all-skip-shaped prompt never receives the update-skip key", {
  timeout: 60_000,
}, async (t) => {
  // An UNRELATED option-only prompt: every option is skip-shaped, so on its own frame it
  // is shaped exactly like a legitimate update continuation.
  const { writes, rendered } = await automatedWritesAfterReplacement(
    "  1. Skip backup\\r\\n  2. Skip",
  );
  assert.match(rendered, /1\.\s*Skip backup/, "the adversarial prompt really rendered");
  assert.doesNotMatch(rendered, /Update available/, "the banner frame was really replaced");
  t.diagnostic(`Real PTY frames rendered; automated writes: ${JSON.stringify(writes)}`);
  assert.deepEqual(
    writes.filter((write) => /^\d+$/.test(write)),
    [],
    "no update-skip digit reached the unrelated all-skip-shaped prompt",
  );
});

test("C-CODEX-22 a real-PTY in-flight retry cannot write into a contradictory replacement", {
  timeout: 60_000,
}, async (t) => {
  // Start from a COMPLETE update screen so a skip attempt is genuinely running (`2. Skip`
  // is written for the first appearance), then swap in a replacement that reassigns `1`
  // AND offers a post-action safe option — so the replacement is independently answerable.
  // The live retry must not carry the first appearance's authorization into it.
  const { writes, rendered } = await automatedWritesAfterReplacement(
    "  1. Skip backup\\r\\n  2. Update now\\r\\n  3. Skip",
    completeUpdatePaint,
  );
  assert.match(rendered, /1\.\s*Skip backup/, "the replacement dialog really rendered");
  assert.match(rendered, /3\.\s*Skip/, "the replacement really offers a post-action safe option");
  t.diagnostic(`Real PTY frames rendered; automated writes: ${JSON.stringify(writes)}`);
  // `1` was `Update now` on the captured appearance and is `Skip backup` on the
  // replacement: it must never be pressed, by the original attempt or its retries.
  assert.ok(
    !writes.includes("1"),
    `a live retry must not press the captured appearance's digit on a replacement; got ${JSON.stringify(writes)}`,
  );
});

test("C-CODEX-22 a real-PTY contradictory replacement keeps holding queued input", {
  timeout: 60_000,
}, async (t) => {
  // The hold must survive the end of an appearance. `blocking_prompt_visible` comes from
  // `dialogVisible`, not from automation eligibility, so a prompt Elwood may not answer
  // still blocks — otherwise a queued paste and its Enter advance an unrelated dialog.
  const { blocking, rendered } = await blockingAcrossReplacement("  1. Skip backup\\r\\n  2. Skip");
  assert.match(rendered, /1\.\s*Skip backup/, "the replacement prompt really rendered");
  t.diagnostic(`blocking_prompt_visible on the replacement frame: ${blocking}`);
  assert.equal(blocking, true, "a prompt Elwood must not automate must still hold queued input");
});

test("C-CODEX-22 a real-PTY first-party-shaped replacement never inherits the skip key", {
  timeout: 60_000,
}, async (t) => {
  // A COMPLETE-looking update screen that reassigns the captured `1`. Recognizing it as
  // first-party is correct; letting it inherit the previous appearance's authorization is
  // not, because the running attempt would press `1` — now `Skip backup` — on a new dialog.
  const { writes, rendered } = await automatedWritesAfterReplacement(
    "  1. Skip backup\\r\\n  2. Update now",
  );
  assert.match(rendered, /1\.\s*Skip backup/, "the replacement dialog really rendered");
  assert.match(rendered, /2\.\s*Update now/, "the replacement really looks first-party");
  t.diagnostic(`Real PTY frames rendered; automated writes: ${JSON.stringify(writes)}`);
  assert.ok(
    !writes.includes("1"),
    `the digit bound to the captured "Update now" must not be pressed on a dialog that reassigned it; got ${JSON.stringify(writes)}`,
  );
});
