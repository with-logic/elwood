/**
 * Real-CLI proof that a Codex which starts on its own update offer has Elwood skip it
 * before any `sendPrompt` input (PRD §5.3, §5.5, C-API-28, C-CODEX-27, C-E2E-27).
 * `sendPrompt` bypasses the readiness queue, so before the session's first readiness only
 * the configured composer may release its write. Codex 0.171's offer selects
 * `› 1. Update now`, and Enter there runs a global installer. Only Elwood's `Skip` digit
 * may reach the offer.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { probeCommandTimeoutMs, probeLaunchTimeoutMs } from "../../src/runtime/probe/index.ts";
import { waitForCondition } from "./bounded-steps.ts";
import { codexLaunches, runCodexTest } from "./codex-test-end.ts";
import {
  inputProblems,
  noInputProblems,
  recordActivity,
  skipEvidence,
  skippedOnce,
} from "./codex-update-offer/checks.ts";
import { codexUpdateOffer } from "./codex-update-offer/index.ts";
import {
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipNow,
  skipReason,
  skipTurns,
} from "./helpers.ts";

// A small model at low effort: the test needs one answered turn. The update check stays
// on (Codex's default) so the armed home opens on the offer.
const CODEX_CONFIG =
  'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\ncheck_for_update_on_startup = true\n';

const READY_MS = 45_000;
const TURN_MS = 45_000;
// A first launch in a fresh home paints the offer later than a resume does.
const OFFER_MS = 30_000;
const LAUNCHES_MS = probeLaunchTimeoutMs + probeCommandTimeoutMs;
const TEST_TIMEOUT_MS = OFFER_MS + READY_MS + TURN_MS + LAUNCHES_MS + 30_000;

const ONE = "Reply exactly: ONE. Do not use tools.";

// Elwood can also read Codex's output late: Codex then takes the key and draws its next
// screen while Elwood still shows the offer, where a second key would reach that screen.
for (const lagAfterSkipMs of [0, 2_000]) {
  const late = lagAfterSkipMs > 0 ? `, read ${lagAfterSkipMs / 1_000} s late after the skip` : "";
  test(`C-E2E-27 Elwood skips the update offer a Codex starts on, before sendPrompt input${late}`, {
    skip: skipIf(skipReason("codex"), skipTurns, codexAuthMissing()),
    timeout: TEST_TIMEOUT_MS,
  }, async (t) => {
    const project = makeProject("codex");
    const sandbox = sandboxedCodexHome(project, CODEX_CONFIG);
    let session: CodexSessionApi | undefined;
    const launches = codexLaunches();
    const input = codexUpdateOffer(sandbox.home, { lagAfterSkipMs });
    await runCodexTest({ sessions: () => [session], sandbox, launches }, async () => {
      const unsupported = await input.unsupported(project.cwd);
      if (unsupported !== undefined) return skipNow(t, unsupported);
      input.arm();
      const prompts: string[] = [];
      let stops = 0;
      const active = await launches.track(
        startCodex({
          cwd: project.cwd,
          stateDir: project.stateDir,
          sandbox: "read-only",
          approvalPolicy: "never",
          autotrust: true,
          hooks: {
            UserPromptSubmit: (event) => {
              prompts.push(event.prompt);
            },
            Stop: () => {
              stops += 1;
            },
          },
        }),
      );
      session = active;
      const activity = recordActivity(active);
      let settled = false;
      const prompt = active.sendPrompt(ONE).finally(() => {
        settled = true;
      });
      // A failed run tears the session down with this prompt still waiting.
      prompt.catch(() => {});
      await waitForCondition(active, () => input.skips.length > 0, "Elwood's skip", OFFER_MS);
      // Checked as the run goes, so a failure names the step that let input through.
      assert.deepEqual(inputProblems(input), noInputProblems);
      await waitForCondition(active, () => settled, "ONE submitted", READY_MS);
      await prompt;
      assert.deepEqual(inputProblems(input), noInputProblems);
      await waitForCondition(active, () => stops >= 1, "ONE answered", TURN_MS);
      assert.deepEqual(inputProblems(input), noInputProblems);
      assert.deepEqual(prompts, [ONE]);
      assert.deepEqual(skipEvidence(input, activity, sandbox.home), skippedOnce);
    }).finally(() => input.dispose());
  });
}
