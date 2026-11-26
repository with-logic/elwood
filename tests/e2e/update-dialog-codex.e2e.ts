/**
 * Real-CLI proof that a Codex update offer Elwood's skip cannot answer is listed and
 * announced for the host (PRD §5.13 "Codex update offers", C-ATTN-12, C-E2E-33). Codex
 * never receives Elwood's `Skip` key here, as when it drops a key it gets while painting,
 * so the skip's retries end with the offer on screen. The host then answers with Codex's
 * own `Skip` key. The offer's default is `› 1. Update now`, so no Enter may reach it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions } from "../../src/core/versions.ts";
import { type CodexSessionApi, type ElwoodDialogEvent, startCodex } from "../../src/index.ts";
import { probeCommandTimeoutMs, probeLaunchTimeoutMs } from "../../src/runtime/probe/index.ts";
import { waitForCondition } from "./bounded-steps.ts";
import { codexLaunches, runCodexTest } from "./codex-test-end.ts";
import { readCodexDismissedVersion } from "./codex-update-check.ts";
import { inputProblems, noInputProblems } from "./codex-update-offer/checks.ts";
import { codexUpdateOffer } from "./codex-update-offer/index.ts";
import { firstLaunchOfferMs, testEndReserveMs } from "./codex-update-offer/timing.ts";
import {
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipNow,
  skipReason,
} from "./helpers.ts";

// No turn runs, so no model quota is spent. The update check stays on (Codex's default).
const CODEX_CONFIG = 'model = "gpt-6-luna"\ncheck_for_update_on_startup = true\n';

// How long this test waits, once Codex paints the offer, for Elwood's skip to give up and
// the offer to be raised. The skip itself waits 500 ms for its first key and then retries
// for 5 s; the remaining 9.5 s absorbs a loaded machine's late frames.
const RAISE_AFTER_PAINT_MS = 15_000;
const READY_MS = 45_000;
const LAUNCHES_MS = probeLaunchTimeoutMs + probeCommandTimeoutMs;
const TEST_TIMEOUT_MS =
  firstLaunchOfferMs + RAISE_AFTER_PAINT_MS + READY_MS + LAUNCHES_MS + testEndReserveMs;

test("C-E2E-33 a Codex update offer whose skip never lands is listed for the host, who skips it", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, CODEX_CONFIG);
  let session: CodexSessionApi | undefined;
  const launches = codexLaunches();
  let hostAnswering = false;
  const input = codexUpdateOffer(sandbox.home, { withholdSkips: () => !hostAnswering });
  await runCodexTest({ sessions: () => [session], sandbox, launches }, async () => {
    const unsupported = await input.unsupported(project.cwd);
    if (unsupported !== undefined) return skipNow(t, unsupported);
    input.arm();
    const active = await launches.track(
      startCodex({
        cwd: project.cwd,
        stateDir: project.stateDir,
        sandbox: "read-only",
        approvalPolicy: "never",
        autotrust: true,
      }),
    );
    session = active;
    const events: ElwoodDialogEvent[] = [];
    // Dialog phases and statuses in the order the session emitted them.
    const trace: string[] = [];
    active.on("dialog", (event) => {
      events.push(event);
      trace.push(`dialog ${event.phase}`);
    });
    active.on("status", (event) => {
      trace.push(`status ${event.status}`);
    });
    await waitForCondition(
      active,
      () => events.length > 0,
      "the offer raised",
      firstLaunchOfferMs + RAISE_AFTER_PAINT_MS,
    );
    assert.ok(input.withheld.length > 0, "Elwood wrote no Skip key for the test to withhold");
    const [request, ...others] = await active.listDialogs();
    assert.deepEqual(others, []);
    assert.equal(events[0]?.request, request);
    assert.equal(request?.kind, "update");
    const { installed, offered } = request.versions ?? { installed: "", offered: "" };
    assert.ok(compareVersions(installed, "0.171.0") >= 0, `installed version ${installed}`);
    assert.equal(offered, "99.0.0");
    assert.equal(
      request.text,
      `Update available · ${installed} → 99.0.0 Release notes: https://github.com/openai/codex/releases/latest`,
    );
    const labels = request.choices.map((choice) => choice.label);
    assert.match(labels[0] ?? "", /^Update now \(runs /);
    assert.deepEqual(labels.slice(1), ["Skip", "Skip until next version"]);
    // The host answers with the offer's own Skip key.
    hostAnswering = true;
    await active.sendKeys(String(labels.indexOf("Skip") + 1));
    await waitForCondition(active, () => events.length > 1, "the offer closed", READY_MS);
    await active.waitForStatus((status) => status === "ready", READY_MS);
    assert.deepEqual(
      events.map((event) => [event.phase, event.phase === "closed" ? event.reason : undefined]),
      [
        ["raised", undefined],
        ["closed", "cleared"],
      ],
    );
    assert.equal(events[1]?.request, request);
    // The offer ends before Codex's first readiness, inside the startup window.
    const closed = trace.indexOf("dialog closed");
    assert.ok(closed >= 0 && trace.indexOf("status ready") > closed, `trace: ${trace.join(", ")}`);
    assert.deepEqual(await active.listDialogs(), []);
    assert.deepEqual(inputProblems(input), noInputProblems);
    assert.deepEqual(input.skips, [String(labels.indexOf("Skip") + 1)]);
    assert.equal(readCodexDismissedVersion(sandbox.home), null);
  }).finally(() => input.dispose());
});
