/**
 * Keys a caller types while Elwood is answering Codex's trust gate must never be submitted
 * by that answer's retry. Under load Codex takes the answer but its next screen reaches
 * Elwood late, so the gate Elwood still sees is stale and its retry would land in Codex's
 * composer after the caller's keys. The test makes that lag certain by holding the CLI's
 * output from Elwood for four seconds once the first answer is written, while Codex itself
 * runs normally, and types as soon as Codex's own output shows its composer. A launch
 * without the gate, or whose composer paints only after the lag, skips loudly. The session
 * uses a bogus model, so a stray submission is refused before using quota. Covers
 * C-TRUST-01 (§5.4).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { bogusModel, type LaggedLaunch, startLaggedCodex } from "./codex-trust-lag.ts";
import { codexAuthMissing, skipIf, skipNow, skipReason, waitFor } from "./helpers.ts";
import { type HeldOutput, outputMatcher } from "./output-hold.ts";
import { trustPromptVisible } from "./trust-screens.ts";

/** Long enough for Codex to take a retried answer while Elwood still sees its gate. */
const lagMs = 4_000;
/** How long after the lag a stray submission has to show itself. */
const settleMs = 5_000;
/** Codex's configured composer: its footer names the session's model. */
const composerOutput = new RegExp(bogusModel);

/**
 * Settles when Codex's raw output draws its configured composer: `held` while that output
 * is still held from Elwood, `shown` otherwise (no gate, or a late paint).
 */
function watchComposer() {
  const composer = Promise.withResolvers<"held" | "shown">();
  const composerUngated = outputMatcher(composerOutput);
  const composerAnswered = outputMatcher(composerOutput);
  const observe = (data: string, held: HeldOutput, launch: LaggedLaunch) => {
    // Behind a gate, only output after the answer can show the configured composer.
    const drawn = launch.displayed
      ? launch.answerWritten && composerAnswered(data)
      : composerUngated(data);
    if (drawn) composer.resolve(held.holding ? "held" : "shown");
  };
  return { composer: composer.promise, observe };
}

test("C-TRUST-01 keys a caller types during Codex's trust answer are never submitted by it", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: 180_000,
}, async (t) => {
  const watch = watchComposer();
  const { session: live, launch } = await startLaggedCodex(t, lagMs, watch.observe);
  const submitted: string[] = [];
  live.on("hook", (event) => {
    if (event.hook_event_name === "UserPromptSubmit") submitted.push(JSON.stringify(event));
  });
  let finished = false;
  const ended = waitFor(
    () => (finished ? "done" : live.status === "exited" ? "exited" : undefined),
    "Codex's composer behind its answered gate",
    120_000,
  ).catch(() => "timeout");
  const outcome = await Promise.race([watch.composer, ended]);
  finished = true;
  const screen = () => live.terminal.snapshot().text;
  assert.notEqual(outcome, "exited", `Codex exited:\n${screen()}`);
  if (!launch.displayed) {
    skipNow(t, `Codex showed no directory-trust prompt (auto-trusted or reworded):\n${screen()}`);
    return;
  }
  assert.notEqual(outcome, "timeout", `Codex never took the answer:\n${screen()}`);
  if (outcome === "shown") {
    skipNow(t, `Codex drew its composer after the ${lagMs} ms lag, so Elwood's view caught up`);
    return;
  }
  // Codex is at its composer; Elwood, its output held, still sees the gate.
  assert.ok(trustPromptVisible(screen(), "codex"), `Elwood's view trails Codex:\n${screen()}`);
  const typedAt = launch.writes.length;
  await live.sendKeys("hello");
  await new Promise((resolve) => setTimeout(resolve, lagMs + settleMs));
  const after = launch.writes.slice(typedAt);
  t.diagnostic(`writes: ${JSON.stringify(launch.writes)}`);
  assert.deepEqual(after, ["hello"], "nothing was written after the caller's keys");
  const stray = submitted.filter((event) => event.includes("hello"));
  assert.deepEqual(stray, [], "the caller's keys were not submitted");
  // A retry is Enter alone while the caret is on the affirmative, so no digit reaches
  // the composer ahead of the caller's keys either.
  assert.match(screen(), /^› hello\s*$/m, `the caller's draft stays in the composer:\n${screen()}`);
});
