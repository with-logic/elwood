/**
 * A Codex whose screen trails its input must never receive the trust number twice. Under
 * load Codex takes the directory-trust answer but paints its composer after the retry
 * interval, so the gate Elwood still sees is stale: a retry typed then reaches the
 * composer, and "1" plus Enter there submits a user message to the model. The test makes
 * that lag certain by holding the CLI's output from Elwood for two seconds once the answer
 * is written; Codex itself runs normally. (Freezing Codex instead makes it exit with "timed
 * out discarding buffered terminal input", whatever is typed.) The session uses a bogus
 * model, so a stray submission is refused before using quota. The launch must show and
 * answer the real gate, or the run skips loudly. Covers C-TRUST-01 (§5.4).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { startLaggedCodex } from "./codex-trust-lag.ts";
import { codexAuthMissing, skipIf, skipNow, skipReason, waitFor } from "./helpers.ts";

const lagMs = 2_000;
/** How long after `ready` a stray submission has to show itself. */
const settleMs = 5_000;

test("C-TRUST-01 a Codex whose screen trails its trust answer never receives the number again", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: 180_000,
}, async (t) => {
  const { session: live, launch } = await startLaggedCodex(t, lagMs);
  const submitted: string[] = [];
  const reports: string[] = [];
  live.on("hook", (event) => {
    if (event.hook_event_name === "UserPromptSubmit") submitted.push(JSON.stringify(event));
  });
  live.on("activity", (event) => {
    if (event.kind === "startup_prompt" && event.label === "workspace_trust")
      reports.push(event.text ?? "");
  });
  // A launch that never shows the gate stays ready unanswered; it skips once the wait ends.
  const reached = await waitFor(
    () =>
      (launch.answerWritten && live.status === "ready") || live.status === "exited" || undefined,
    "the launch reaches ready after its answer write",
    120_000,
  ).catch(() => false);
  const written = () => JSON.stringify(launch.writes.filter((input) => input.endsWith("\r")));
  const now = () => live.terminal.snapshot().text;
  assert.notEqual(live.status, "exited", `Codex exited; writes ${written()}:\n${now()}`);
  if (!reached && live.status === "ready" && !launch.displayed) {
    skipNow(t, `Codex showed no directory-trust prompt (auto-trusted or reworded):\n${now()}`);
    return;
  }
  assert.ok(
    reached,
    `no ready after the answer write; status ${live.status}; writes ${written()}:\n${now()}`,
  );
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const screen = live.terminal.snapshot().text;
  const answers = launch.writes.filter((input) => input.endsWith("\r"));
  t.diagnostic(`trust writes: ${JSON.stringify(answers)}`);
  assert.equal(live.status, "ready", `the launch stayed ready:\n${screen}`);
  assert.equal(answers.filter((input) => input === "1\r").length, 1, "the number was typed once");
  assert.deepEqual(submitted, [], "no user message was submitted");
  assert.doesNotMatch(screen, /^› 1\s*$/m, `"1" never reached the composer:\n${screen}`);
  assert.equal(reports.length, 1, `one report: ${JSON.stringify(reports)}`);
  assert.match(reports[0] ?? "", /\bsent 1\b/, "the report names the number sent");
});
