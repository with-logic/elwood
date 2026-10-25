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
import { execFileSync } from "node:child_process";
import test from "node:test";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import { endCodexTest } from "./codex-ready.ts";
import {
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipNow,
  skipReason,
  waitFor,
} from "./helpers.ts";
import { holdCliOutput, outputMatcher } from "./output-hold.ts";
import { trustPromptVisible } from "./trust-screens.ts";

const bogusModel = "gpt-elwood-nonexistent-model";
/** Long enough for Codex to take a retried answer while Elwood still sees its gate. */
const lagMs = 4_000;
/** How long after the lag a stray submission has to show itself. */
const settleMs = 5_000;
const directoryTrustOutput = /trustthisfolder\?|trustthecontentsofthisdirectory/i;
/** Codex's configured composer: its footer names the session's model. */
const composerOutput = new RegExp(bogusModel);

type Launch = {
  displayed: boolean;
  /** Elwood wrote its first trust answer. Codex can discard it while its gate paints. */
  answerWritten: boolean;
  readonly writes: string[];
  /**
   * Settles when Codex's raw output draws its configured composer: `held` while that
   * output is still held from Elwood, `shown` otherwise (no gate, or a late paint).
   */
  readonly composer: PromiseWithResolvers<"held" | "shown">;
};

/**
 * Records the launch's writes. Elwood sees no output for `lagMs` after the first trust
 * answer write. The raw output, held or not, reveals when Codex has drawn its composer.
 */
function lagAfterAnswerWrite(): Launch {
  const launch: Launch = {
    displayed: false,
    answerWritten: false,
    writes: [],
    composer: Promise.withResolvers(),
  };
  const gate = outputMatcher(directoryTrustOutput);
  const composerUngated = outputMatcher(composerOutput);
  const composerAnswered = outputMatcher(composerOutput);
  holdCliOutput({
    output(data, output) {
      if (!launch.displayed) launch.displayed = gate(data);
      // Behind a gate, only output after the answer can show the configured composer.
      const composer = launch.displayed
        ? launch.answerWritten && composerAnswered(data)
        : composerUngated(data);
      if (composer) launch.composer.resolve(output.holding ? "held" : "shown");
    },
    input(data, output) {
      launch.writes.push(data);
      if (data !== "1\r" || launch.answerWritten) return;
      launch.answerWritten = true;
      output.hold(lagMs);
    },
  });
  return launch;
}

test("C-TRUST-01 keys a caller types during Codex's trust answer are never submitted by it", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: 180_000,
}, async (t) => {
  const project = makeProject("codex");
  execFileSync("git", ["init", "-q", project.cwd]);
  const sandbox = sandboxedCodexHome(project, "check_for_update_on_startup = false\n");
  const launch = lagAfterAnswerWrite();
  let session: CodexSessionApi | undefined;
  let launchRejected = false;
  t.after(async () => {
    try {
      // The sandbox goes only once every Codex process that could use it is confirmed gone.
      await endCodexTest({
        sessions: [session],
        project,
        sandbox,
        launchRejected,
        failure: undefined,
      });
    } finally {
      resetRuntimeSeamsForTests();
    }
  });
  session = await startCodex({
    cwd: project.cwd,
    stateDir: project.stateDir,
    model: bogusModel,
    autotrust: true,
  }).catch((error: unknown) => {
    launchRejected = true;
    throw error;
  });
  const live = session;
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
  const outcome = await Promise.race([launch.composer.promise, ended]);
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
