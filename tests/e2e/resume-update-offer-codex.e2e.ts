/**
 * Real-CLI proof that a RESUMED Codex which opens on a screen Elwood does not recognize
 * receives no queued input (PRD §5.3, C-API-28, C-E2E-26). Codex 0.171.0 paints a
 * `› Ask Codex to do anything` placeholder and then its update offer, whose selected row
 * is `› 1. Update now`; Elwood's update recognizer matches only Codex 0.155's layout.
 * Both carry the composer marker, and Enter on the offer runs a global installer. The
 * queued message must stay held until the host answers the offer with a raw key and
 * Codex shows its configured composer.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type CodexSessionApi, resumeCodex, startCodex } from "../../src/index.ts";
import { probeCommandTimeoutMs, probeLaunchTimeoutMs } from "../../src/runtime/probe/index.ts";
import { sendWithin, waitForCondition } from "./bounded-steps.ts";
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
// Longer than the 10 s readiness deadline, so the resume composer path and the deadline
// have both had their chance to write.
const HOLD_MS = 12_000;
const LAUNCHES_MS = 2 * (probeLaunchTimeoutMs + probeCommandTimeoutMs);
const TEST_TIMEOUT_MS =
  2 * (READY_MS + SEND_MS + TURN_MS) + SESSION_START_MS + OFFER_MS + HOLD_MS + LAUNCHES_MS + 30_000;

const ONE = "Reply exactly: ONE. Do not use tools.";

test("C-E2E-26 a resumed Codex that opens on its update offer receives no queued input", {
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
  const input = codexUpdateOffer(sandbox.home);
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
    const screen = () => active.terminal.snapshot().text;
    input.watch(screen);
    let settled = false;
    const queued = active.sendMessage(ONE).finally(() => {
      settled = true;
    });
    // A failed run tears the session down with this send still queued.
    queued.catch(() => {});
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
    assert.equal(settled, false, "the queued message stays queued");
    assert.notEqual(active.status, "ready");
    const skip = offerSkipDigit(screen());
    assert.ok(skip !== undefined, "the offer is still on screen");

    // The host answers the offer itself; the held message then drains to a real turn.
    input.release(skip);
    await active.sendKeys(skip);
    await waitForCondition(active, () => settled, "queued ONE submitted", READY_MS + SEND_MS);
    await queued;
    await waitForCondition(active, () => stops >= 1, "queued ONE answered", TURN_MS);
    assert.deepEqual(prompts, [ONE]);
    assert.deepEqual(input.refused, []);
  }).finally(() => input.dispose());
});
