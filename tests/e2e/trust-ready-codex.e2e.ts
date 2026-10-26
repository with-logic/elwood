/**
 * A Codex whose directory-trust gate paints after the cold-start readiness deadline must
 * not report `ready` before that gate is answered. Codex 0.164 paints an empty boot
 * composer, without its model footer, about half a second after its first output; under
 * load its gate followed 11 to 31 seconds later, and the 10-second deadline fired on the
 * boot composer. The test makes that lateness certain: once the boot composer is out, it
 * holds the CLI's output from Elwood for 12 seconds, so Elwood's deadline expires on the
 * boot composer while Codex itself runs normally. The launch must show and answer the real
 * gate, or the run skips loudly. No model turn is sent, and the session uses a bogus model
 * so that a stray one would be refused before using quota. Readiness must come from the
 * real configured composer, so no `initial_ready_backstop` warning. Covers C-API-28 (§5.3).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { resetRuntimeSeamsForTests } from "../../src/runtime/seams.ts";
import { teardownOrKillCodex } from "./codex-ready.ts";
import {
  bogusCodexModel,
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

/** Longer than the 10-second deadline, which starts at Elwood's first rendered frame. */
const holdMs = 12_000;
const bootComposerOutput = /forshortcuts/i;
const directoryTrustOutput = /trustthisfolder\?|trustthecontentsofthisdirectory/i;

type Launch = {
  heldAt?: number;
  releasedAt?: number;
  displayed: boolean;
  answeredAt?: number;
};

/** Holds the CLI's output from Elwood for `holdMs` once its boot composer is out. */
function holdAfterBootComposer(): Launch {
  const launch: Launch = { displayed: false };
  const gate = outputMatcher(directoryTrustOutput);
  const bootComposer = outputMatcher(bootComposerOutput);
  holdCliOutput({
    output(data, output) {
      if (launch.displayed) return;
      launch.displayed = gate(data);
      const boot = bootComposer(data);
      if (launch.heldAt !== undefined || launch.displayed || !boot) return;
      // Elwood sees the boot composer itself, then nothing for `holdMs`.
      launch.heldAt = Date.now();
      output.hold(holdMs, () => {
        launch.releasedAt = Date.now();
      });
    },
    input(data) {
      if (data === "1\r") launch.answeredAt ??= Date.now();
    },
  });
  return launch;
}

test("C-API-28 a Codex trust gate painted after the readiness deadline precedes ready", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: 180_000,
}, async (t) => {
  const project = makeProject("codex");
  execFileSync("git", ["init", "-q", project.cwd]);
  const sandbox = sandboxedCodexHome(project, "check_for_update_on_startup = false\n");
  const launch = holdAfterBootComposer();
  let session: CodexSessionApi | undefined;
  t.after(async () => {
    let failures: readonly unknown[] = [];
    try {
      if (session !== undefined) failures = await teardownOrKillCodex(session);
    } finally {
      resetRuntimeSeamsForTests();
      sandbox.dispose();
    }
    if (failures.length > 0) throw new AggregateError(failures, "Codex teardown failed");
  });
  session = await startCodex({
    cwd: project.cwd,
    stateDir: project.stateDir,
    model: bogusCodexModel,
    autotrust: true,
  });
  const live = session;
  let readyAt: number | undefined;
  let readyScreen = "";
  const backstopWarnings: string[] = [];
  live.on("warning", (warning) => {
    if (warning.code === "initial_ready_backstop") backstopWarnings.push(warning.message);
  });
  live.on("status", ({ status }) => {
    if (status !== "ready" || readyAt !== undefined) return;
    readyAt = Date.now();
    readyScreen = live.terminal.snapshot().text;
  });
  // A launch that never shows the gate stays ready unanswered; it skips once the wait ends.
  const reached = await waitFor(
    () =>
      (launch.answeredAt !== undefined && live.status === "ready") ||
      live.status === "exited" ||
      undefined,
    "the answered launch reaches ready",
    120_000,
  ).catch(() => false);
  const screen = live.terminal.snapshot().text;
  assert.notEqual(live.status, "exited", `Codex exited:\n${screen}`);
  if (!reached && live.status === "ready" && !launch.displayed) {
    skipNow(t, `Codex showed no directory-trust prompt (auto-trusted or reworded):\n${screen}`);
    return;
  }
  assert.ok(reached, `no answered ready; status ${live.status}; screen:\n${screen}`);
  // A hold starts only on a boot composer seen before the gate.
  if (launch.heldAt === undefined) {
    skipNow(t, `no boot composer was recognized before the gate, so nothing was held:\n${screen}`);
    return;
  }
  const { heldAt, releasedAt, answeredAt } = launch;
  const since = (at: number | undefined) => (at === undefined ? "never" : `${at - heldAt} ms`);
  t.diagnostic(
    `after the boot composer: released ${since(releasedAt)}, answered ${since(answeredAt)}, ` +
      `first ready ${since(readyAt)}`,
  );
  assert.equal(
    live.status,
    "ready",
    `the answered launch is ready:\n${live.terminal.snapshot().text}`,
  );
  assert.ok(answeredAt !== undefined && readyAt !== undefined);
  assert.ok(
    readyAt >= answeredAt,
    `ready came ${answeredAt - readyAt} ms before the trust answer, on:\n${readyScreen}`,
  );
  assert.equal(
    trustPromptVisible(readyScreen, "codex"),
    false,
    `ready on the gate:\n${readyScreen}`,
  );
  // Readiness came from the real configured composer, not from the 60-second backstop.
  assert.deepEqual(backstopWarnings, [], `no backstop release:\n${readyScreen}`);
});
