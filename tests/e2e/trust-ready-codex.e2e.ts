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
import { createCliSanitizer } from "../../src/cli/output/sanitize.ts";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { resetRuntimeSeamsForTests, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { teardownOrKillCodex } from "./codex-ready.ts";
import {
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipNow,
  skipReason,
  waitFor,
} from "./helpers.ts";
import { trustPromptVisible } from "./trust-screens.ts";

/** Codex refuses a turn on an unknown model before any quota is used. */
const bogusModel = "gpt-elwood-nonexistent-model";
/** Longer than the 10-second deadline, which starts at Elwood's first rendered frame. */
const holdMs = 12_000;
/** Codex draws spaces as cursor moves, so raw output is matched without them. */
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
  const plainText = createCliSanitizer();
  setPtyFactoryForTests((options) => {
    const pty = nodePtyFactory(options);
    const handlers = new Set<(data: string) => void>();
    let held: string[] | undefined;
    let output = "";
    const deliver = (data: string) => {
      for (const handler of handlers) handler(data);
    };
    const hold = () => {
      launch.heldAt = Date.now();
      held = [];
      setTimeout(() => {
        const chunks = held ?? [];
        held = undefined;
        launch.releasedAt = Date.now();
        for (const chunk of chunks) deliver(chunk);
      }, holdMs);
    };
    pty.onData((data) => {
      if (!launch.displayed) {
        output += data;
        const plain = plainText(output).replace(/\s+/g, "");
        launch.displayed = directoryTrustOutput.test(plain);
        if (launch.heldAt === undefined && !launch.displayed && bootComposerOutput.test(plain)) {
          deliver(data); // Elwood sees the boot composer itself, then nothing for `holdMs`.
          hold();
          return;
        }
      }
      if (held === undefined) deliver(data);
      else held.push(data);
    });
    return {
      ...pty,
      onData(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      write(data) {
        pty.write(data);
        if (data === "1\r") launch.answeredAt ??= Date.now();
      },
    };
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
    model: bogusModel,
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
