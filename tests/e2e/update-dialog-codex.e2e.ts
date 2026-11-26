/**
 * Real-CLI proof that a Codex update offer Elwood's skip cannot answer is listed and
 * announced for the host (PRD §5.13 "Codex update offers", C-ATTN-10, C-E2E-30). Codex
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

// A first launch in a fresh home paints the offer later than a resume does.
const OFFER_MS = 30_000;
// The skip waits 500 ms for its first key and retries for 5 s.
const RETRIES_MS = 15_000;
const READY_MS = 45_000;
const LAUNCHES_MS = probeLaunchTimeoutMs + probeCommandTimeoutMs;
const TEST_TIMEOUT_MS = OFFER_MS + RETRIES_MS + READY_MS + LAUNCHES_MS + 30_000;

test("C-E2E-30 a Codex update offer whose skip never lands is listed for the host, who skips it", {
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
    active.on("dialog", (event) => {
      events.push(event);
    });
    await waitForCondition(
      active,
      () => events.length > 0,
      "the offer raised",
      OFFER_MS + RETRIES_MS,
    );
    assert.ok(input.withheld.length > 0, "Elwood wrote its Skip key");
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
    assert.deepEqual(await active.listDialogs(), []);
    assert.deepEqual(inputProblems(input), noInputProblems);
    assert.deepEqual(input.skips, [String(labels.indexOf("Skip") + 1)]);
    assert.equal(readCodexDismissedVersion(sandbox.home), null);
  }).finally(() => input.dispose());
});
