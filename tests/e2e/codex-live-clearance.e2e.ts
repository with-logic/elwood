/** Real production cursor/PTY trust recovery with queued input (C-TRUST-01). */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import { codexLaunches, endCodexTestAfter } from "./codex-test-end.ts";
import {
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
  skipTurns,
  waitFor,
} from "./helpers.ts";

// Codex's own directory-trust question and affirmative: 0.15x asked "Do you trust the contents
// of this directory?" with "Yes, continue"; 0.164 asks "Trust this folder?" with "Trust and
// continue", and only inside a Git repository (docs/cli-behavior.md).
const trustQuestion = /Do you trust the contents of this directory\?|Trust this folder\?/;
const trustAffirmative = /Yes, continue|Trust and continue/;

test("C-TRUST-01 production Codex holds queued input through human trust and native cursor clearance", {
  skip: skipIf(skipReason("codex"), codexAuthMissing(), skipTurns),
  timeout: 90_000,
}, async (t) => {
  const project = makeProject("codex");
  execFileSync("git", ["init", "-q", project.cwd]);
  const sandbox = sandboxedCodexHome(project, "check_for_update_on_startup = false\n");
  const launches = codexLaunches();
  let session: CodexSessionApi | undefined;
  // The sandbox goes only once every Codex process that could use it is confirmed gone.
  t.after(() => endCodexTestAfter(t, { sessions: [session], sandbox, launches }));
  let submitted = 0;
  const order: string[] = [];
  let cursorVisible = false;
  let observedTrust = false;
  session = await launches.track(
    startCodex({
      cwd: project.cwd,
      stateDir: project.stateDir,
      initialSize: { cols: 100, rows: 30 },
      autotrust: false,
      sandbox: "read-only",
      approvalPolicy: "never",
      hooks: {
        UserPromptSubmit: () => {
          submitted++;
          order.push("submit");
        },
      },
    }),
  );
  const active = session;
  const inputs: string[] = [];
  const inputSubscription = active.terminal.xterm.onData((input) => {
    inputs.push(input);
    if (input.includes("ELWOOD_NATIVE_CURSOR_QUEUE_PROBE")) order.push("caller-input");
  });
  t.after(() => inputSubscription.dispose());
  // Independent native observation: raw DEC25 mode plus the actual input row.
  active.on("terminal:data", ({ data }) => {
    for (const part of data.split("\u001b")) {
      const mode = /^\[\?25([hl])/.exec(part);
      if (mode) cursorVisible = mode[1] === "h";
    }
    const frame = active.terminal.snapshot();
    if (trustQuestion.test(frame.text)) {
      observedTrust = true;
      order.length = 0;
    }
    const buffer = active.terminal.xterm.buffer.active;
    const row = frame.cursorY + buffer.baseY - buffer.viewportY;
    if (
      observedTrust &&
      cursorVisible &&
      frame.cursorX === 2 &&
      /^› (?:Ask|Write|Implement|Find|Summarize|Explain|Improve|Run|Use|Type|Describe|Review|What)/.test(
        frame.lines[row] ?? "",
      ) &&
      !trustQuestion.test(frame.text) &&
      !trustAffirmative.test(frame.text)
    )
      order.push("native-clear");
  });
  let sent = false;
  const pending = active
    .sendMessage(
      "Reply exactly ELWOOD_NATIVE_CURSOR_QUEUE_PROBE. Do not use tools or modify files.",
    )
    .then(() => {
      sent = true;
    });
  void pending.catch(() => undefined);
  await waitFor(
    () =>
      trustQuestion.test(active.terminal.snapshot().text) &&
      trustAffirmative.test(active.terminal.snapshot().text)
        ? true
        : undefined,
    "native untrusted directory dialog",
    25_000,
  );
  await active.terminal.settled();
  assert.equal(active.status, "blocked");
  assert.equal(
    inputs.some((input) => input.includes("ELWOOD_NATIVE_CURSOR_QUEUE_PROBE")),
    false,
  );
  assert.equal(cursorVisible, false);
  assert.equal(sent, false);
  assert.equal(submitted, 0);
  assert.equal(order.length, 0);
  await active.sendKeys("1\r");
  await waitFor(
    () => (submitted === 1 ? true : undefined),
    "one queued production submission",
    45_000,
  );
  await pending;
  assert.equal(order[0], "native-clear");
  assert.ok(order.indexOf("native-clear") < order.indexOf("caller-input"));
  assert.ok(order.indexOf("caller-input") < order.indexOf("submit"));
  assert.equal(submitted, 1);
  assert.equal(
    inputs.filter((input) => input.includes("ELWOOD_NATIVE_CURSOR_QUEUE_PROBE")).length,
    1,
  );
  t.diagnostic(
    "Real startCodex, isolated config, human directory trust, native cursor, one benign queued submission.",
  );
});
