/**
 * Real-CLI proof that a Codex which starts on a screen Elwood does not recognize receives
 * no prompt from `sendPrompt` (PRD §5.3, C-API-28, C-E2E-27). `sendPrompt` bypasses the
 * readiness queue, so before the session's first readiness only the configured composer
 * may release its write. Codex 0.171.0's update offer selects `› 1. Update now`, which
 * Elwood's update recognizer does not match (it knows Codex 0.155's layout), and Enter
 * there runs a global installer.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { probeCommandTimeoutMs, probeLaunchTimeoutMs } from "../../src/runtime/probe/index.ts";
import { waitForCondition } from "./bounded-steps.ts";
import { codexLaunches, runCodexTest } from "./codex-test-end.ts";
import { codexUpdateOffer, offerSkipDigit, refusedAtMarkedRows } from "./codex-update-offer.ts";
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
// Longer than the 10 s readiness deadline, well short of the 60 s backstop.
const HOLD_MS = 12_000;
const LAUNCHES_MS = probeLaunchTimeoutMs + probeCommandTimeoutMs;
const TEST_TIMEOUT_MS = OFFER_MS + HOLD_MS + READY_MS + TURN_MS + LAUNCHES_MS + 30_000;

const ONE = "Reply exactly: ONE. Do not use tools.";

test("C-E2E-27 a Codex that starts on its update offer receives no sendPrompt input", {
  skip: skipIf(skipReason("codex"), skipTurns, codexAuthMissing()),
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, CODEX_CONFIG);
  let session: CodexSessionApi | undefined;
  const launches = codexLaunches();
  const input = codexUpdateOffer(sandbox.home);
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
    const screen = () => active.terminal.snapshot().text;
    input.watch(screen);
    let settled = false;
    const prompt = active.sendPrompt(ONE).finally(() => {
      settled = true;
    });
    // A failed run tears the session down with this prompt still waiting.
    prompt.catch(() => {});
    await waitForCondition(
      active,
      () => offerSkipDigit(screen()) !== undefined,
      "the update offer",
      OFFER_MS,
    );
    await delay(HOLD_MS);
    assert.deepEqual(
      refusedAtMarkedRows(input.refused),
      [],
      "no application input may be written while the update offer is on screen",
    );
    assert.equal(settled, false, "the prompt waits for the configured composer");
    const skip = offerSkipDigit(screen());
    assert.ok(skip !== undefined, "the offer is still on screen");

    // The host answers the offer itself; the waiting prompt is then submitted once.
    input.release(skip);
    await active.sendKeys(skip);
    await waitForCondition(active, () => settled, "ONE submitted", READY_MS);
    await prompt;
    await waitForCondition(active, () => stops >= 1, "ONE answered", TURN_MS);
    assert.deepEqual(prompts, [ONE]);
    assert.deepEqual(input.refused, []);
  }).finally(() => input.dispose());
});
