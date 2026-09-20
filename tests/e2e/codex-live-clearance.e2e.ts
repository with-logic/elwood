/** Real production cursor/PTY trust recovery with queued input (C-TRUST-01). */
import assert from "node:assert/strict";
import test from "node:test";
import { type CodexSessionApi, startCodex } from "../../src/index.ts";
import {
  cleanup,
  codexAuthMissing,
  makeProject,
  sandboxedCodexHome,
  skipIf,
  skipReason,
  skipTurns,
  waitFor,
} from "./helpers.ts";

test("C-TRUST-01 production Codex holds queued input through human trust and native cursor clearance", {
  skip: skipIf(skipReason("codex"), codexAuthMissing(), skipTurns),
  timeout: 90_000,
}, async (t) => {
  const project = makeProject("codex");
  const sandbox = sandboxedCodexHome(project, "check_for_update_on_startup = false\n");
  let session: CodexSessionApi | undefined;
  t.after(async () => {
    await cleanup(session);
    sandbox.dispose();
  });
  let submitted = 0;
  const order: string[] = [];
  let cursorVisible = false;
  let observedTrust = false;
  session = await startCodex({
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
  });
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
    if (/Do you trust the contents of this directory\?/.test(frame.text)) {
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
      !/Do you trust|Yes, continue/.test(frame.text)
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
      /Do you trust the contents of this directory\?/.test(active.terminal.snapshot().text) &&
      /Yes, continue/.test(active.terminal.snapshot().text)
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
