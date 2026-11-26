/**
 * Real-CLI proof that a RESUMED Codex which opens on its own update offer has Elwood skip
 * it before any queued input (PRD §5.3, §5.5, C-API-28, C-CODEX-27, C-E2E-26). Codex
 * 0.171 paints a `Resuming session…` placeholder and then the offer, whose selected row
 * is `› 1. Update now`. Both carry the composer marker, and Enter on the offer runs a
 * global installer. Only Elwood's `Skip` digit may reach the offer; the queued message
 * then drains onto the configured composer.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { type CodexSessionApi, resumeCodex, startCodex } from "../../src/index.ts";
import { probeCommandTimeoutMs, probeLaunchTimeoutMs } from "../../src/runtime/probe/index.ts";
import { sendWithin, waitForCondition } from "./bounded-steps.ts";
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

// A small model at low effort: the test needs a resumable conversation and one drained turn.
// The update check stays on (Codex's default) so the armed home opens on the offer.
const CODEX_CONFIG =
  'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\ncheck_for_update_on_startup = true\n';

const READY_MS = 45_000;
const TURN_MS = 45_000;
const SEND_MS = 10_000;
const SESSION_START_MS = 10_000;
// Codex paints the offer within a second of a resume; a loaded host gets more.
const OFFER_MS = 20_000;
const LAUNCHES_MS = 2 * (probeLaunchTimeoutMs + probeCommandTimeoutMs);
const TEST_TIMEOUT_MS =
  2 * (READY_MS + SEND_MS + TURN_MS) + SESSION_START_MS + OFFER_MS + LAUNCHES_MS + 30_000;

const ONE = "Reply exactly: ONE. Do not use tools.";

// Elwood can also read Codex's output late: Codex then takes the key and draws its next
// screen while Elwood still shows the offer, where a second key would reach that screen.
for (const lagAfterSkipMs of [0, 2_000]) {
  const late = lagAfterSkipMs > 0 ? `, read ${lagAfterSkipMs / 1_000} s late after the skip` : "";
  test(`C-E2E-26 Elwood skips the update offer a resumed Codex opens on, before queued input${late}`, {
    skip: skipIf(skipReason("codex"), skipTurns, codexAuthMissing()),
    timeout: TEST_TIMEOUT_MS,
  }, async (t) => {
    const project = makeProject("codex");
    const sandbox = sandboxedCodexHome(project, CODEX_CONFIG);
    const opts = {
      cwd: project.cwd,
      stateDir: project.stateDir,
      sandbox: "read-only" as const,
      approvalPolicy: "never" as const,
      autotrust: true,
    };
    let first: CodexSessionApi | undefined;
    let resumed: CodexSessionApi | undefined;
    const launches = codexLaunches();
    const input = codexUpdateOffer(sandbox.home, { lagAfterSkipMs });
    await runCodexTest({ sessions: () => [resumed, first], sandbox, launches }, async () => {
      const unsupported = await input.unsupported(project.cwd);
      if (unsupported !== undefined) return skipNow(t, unsupported);
      const session = await launches.track(startCodex({ ...opts, hooks: {} }));
      first = session;
      // Codex fires `SessionStart` at the first prompt; it carries the id a resume needs.
      let sessionStarted = false;
      session.on("hook", (event) => {
        if (event.hook_event_name === "SessionStart") sessionStarted = true;
      });
      await waitForCondition(session, () => session.status === "ready", "first ready", READY_MS);
      await sendWithin(session, "Reply exactly: OK. Do not use tools.", "the first turn", SEND_MS);
      await waitForCondition(session, () => session.status === "ready", "first turn", TURN_MS);
      await waitForCondition(session, () => sessionStarted, "first SessionStart", SESSION_START_MS);
      const elwoodSessionId = session.elwoodSessionId;
      await session.stop();

      input.arm();
      const prompts: string[] = [];
      let stops = 0;
      const active = await launches.track(
        resumeCodex({
          ...opts,
          elwoodSessionId,
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
      resumed = active;
      const activity = recordActivity(active);
      let settled = false;
      const queued = active.sendMessage(ONE).finally(() => {
        settled = true;
      });
      // A failed run tears the session down with this send still queued.
      queued.catch(() => {});
      await waitForCondition(active, () => input.skips.length > 0, "Elwood's skip", OFFER_MS);
      // Checked as the run goes, so a failure names the step that let input through.
      assert.deepEqual(inputProblems(input), noInputProblems);
      await waitForCondition(active, () => settled, "queued ONE submitted", READY_MS + SEND_MS);
      await queued;
      assert.deepEqual(inputProblems(input), noInputProblems);
      await waitForCondition(active, () => stops >= 1, "queued ONE answered", TURN_MS);
      assert.deepEqual(inputProblems(input), noInputProblems);
      assert.deepEqual(prompts, [ONE]);
      assert.deepEqual(skipEvidence(input, activity, sandbox.home), skippedOnce);
    }).finally(() => input.dispose());
  });
}
