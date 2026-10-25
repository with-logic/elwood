/**
 * A Codex whose screen trails its input must never receive the trust number twice. Under
 * load Codex takes the directory-trust answer but paints its composer after the retry
 * interval, so the gate Elwood still sees is stale: a retry typed then reaches the
 * composer, and "1" plus Enter there submits a user message to the model. The test makes
 * that lag certain by holding the CLI's output from Elwood for two seconds once the answer
 * is written; Codex itself runs normally. (Freezing Codex instead makes it exit with "timed
 * out discarding buffered terminal input", whatever is typed.) The launch must show and
 * answer the real gate, or the run skips loudly. Implements C-E2E-09 for C-TRUST-01 (§5.4).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createCliSanitizer } from "../../src/cli/output/sanitize.ts";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { resetRuntimeSeamsForTests, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { stopCodex } from "./codex-ready.ts";
import {
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipNow,
  skipReason,
  waitFor,
} from "./helpers.ts";

const lagMs = 2_000;
/** How long after `ready` a stray submission has to show itself. */
const settleMs = 5_000;
/** Codex draws spaces as cursor moves, so the raw prompt is matched without them. */
const directoryTrustOutput = /trustthisfolder\?|trustthecontentsofthisdirectory/i;

type Launch = { displayed: boolean; answered: boolean; readonly writes: string[] };

/** Records the launch's writes; Elwood sees no output for `lagMs` after the trust answer. */
function lagAfterAnswer(): Launch {
  const launch: Launch = { displayed: false, answered: false, writes: [] };
  const plainText = createCliSanitizer();
  setPtyFactoryForTests((options) => {
    const pty = nodePtyFactory(options);
    const handlers = new Set<(data: string) => void>();
    let held: string[] | undefined;
    let output = "";
    pty.onData((data) => {
      if (!launch.displayed) {
        output += data;
        launch.displayed = directoryTrustOutput.test(plainText(output).replace(/\s+/g, ""));
      }
      if (held === undefined) for (const handler of handlers) handler(data);
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
        if (typeof data === "string") launch.writes.push(data);
        if (data !== "1\r" || launch.answered) return;
        launch.answered = true;
        held = [];
        setTimeout(() => {
          const chunks = held ?? [];
          held = undefined;
          for (const chunk of chunks) for (const handler of handlers) handler(chunk);
        }, lagMs);
      },
    };
  });
  return launch;
}

test("C-E2E-09 a Codex whose screen trails its trust answer never receives the number again", {
  skip: skipIf(skipReason("codex"), codexAuthMissing()),
  timeout: 180_000,
}, async (t) => {
  const project = makeProject("codex");
  execFileSync("git", ["init", "-q", project.cwd]);
  const sandbox = sandboxedCodexHome(project, "check_for_update_on_startup = false\n");
  const launch = lagAfterAnswer();
  let session: CodexSessionApi | undefined;
  t.after(async () => {
    try {
      if (session !== undefined) await stopCodex(session);
    } finally {
      resetRuntimeSeamsForTests();
      sandbox.dispose();
    }
  });
  session = await startCodex({ cwd: project.cwd, stateDir: project.stateDir, autotrust: true });
  const live = session;
  const submitted: string[] = [];
  const reports: string[] = [];
  live.on("hook", (event) => {
    if (event.hook_event_name === "UserPromptSubmit") submitted.push(JSON.stringify(event));
  });
  live.on("activity", (event) => {
    if (event.kind === "startup_prompt" && event.label === "workspace_trust")
      reports.push(event.text ?? "");
  });
  await waitFor(
    () => (launch.answered && live.status === "ready") || live.status === "exited" || undefined,
    "the answered launch reaches ready",
    120_000,
  ).catch((error: unknown) => {
    const answers = JSON.stringify(launch.writes.filter((input) => input.endsWith("\r")));
    throw new Error(
      `${String(error)}; status ${live.status}; writes ${answers}; screen:\n${live.terminal.snapshot().text}`,
    );
  });
  if (!launch.displayed) {
    skipNow(
      t,
      "Codex displayed no directory-trust prompt (auto-trusted or reworded); screen:\n" +
        live.terminal.snapshot().text,
    );
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const screen = live.terminal.snapshot().text;
  const answers = launch.writes.filter((input) => input.endsWith("\r"));
  t.diagnostic(`trust writes: ${JSON.stringify(answers)}`);
  assert.equal(live.status, "ready", `the launch stayed ready:\n${screen}`);
  assert.equal(answers.filter((input) => input === "1\r").length, 1, "the number was typed once");
  assert.deepEqual(submitted, [], "no user message was submitted");
  assert.doesNotMatch(screen, /^› 1\s*$/m, `"1" never reached the composer:\n${screen}`);
  assert.deepEqual(reports, ["Detected codex workspace_trust prompt; sent 1."]);
});
