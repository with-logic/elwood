/** Real human trust holds queued Claude input until native cursor clearance (C-TRUST-01). */
import assert from "node:assert/strict";
import test from "node:test";
import { optionKeystrokes, selectableOptions } from "../../src/core/terminal-options.ts";
import { type ClaudeSessionApi, startClaude } from "../../src/index.ts";
import { nodePtyFactory } from "../../src/pty/node.ts";
import { resetRuntimeSeamsForTests, setPtyFactoryForTests } from "../../src/runtime/seams.ts";
import { cleanup, makeProject, skipIf, skipReason, waitFor } from "./helpers.ts";
import { completeFolderTrustScreenVisible, folderTrustScreenVisible } from "./trust-screens.ts";

test("C-TRUST-01 production Claude holds queued input through human trust and native cursor clearance", {
  skip: skipIf(skipReason("claude")),
  timeout: 90_000,
}, async (t) => {
  const project = makeProject("claude");
  const marker = "ELWOOD_CLAUDE_NATIVE_CURSOR_QUEUE_PROBE";
  const order: string[] = [];
  const inputs: string[] = [];
  let session: ClaudeSessionApi | undefined;
  let cursorVisible = false;
  let observedTrust = false;
  let sent = false;
  t.after(async () => {
    try {
      await cleanup(session);
    } finally {
      resetRuntimeSeamsForTests();
    }
  });
  // Delegate every operation to the real PTY; record at the actual write boundary.
  setPtyFactoryForTests((options) => {
    const pty = nodePtyFactory(options);
    return {
      ...pty,
      write(data) {
        pty.write(data);
        const input = typeof data === "string" ? data : Buffer.from(data).toString();
        inputs.push(input);
        if (input.includes(marker)) order.push("caller-input");
      },
    };
  });
  session = await startClaude({
    cwd: project.cwd,
    stateDir: project.stateDir,
    initialSize: { cols: 100, rows: 35 },
    autotrust: false,
  });
  const active = session;
  // Independent oracle: native DEC25 mode and the actual cursor's fenced composer row.
  active.on("terminal:data", ({ data }) => {
    for (const part of data.split("\u001b")) {
      const mode = /^\[\?25([hl])/.exec(part);
      if (mode) cursorVisible = mode[1] === "h";
    }
    const frame = active.terminal.snapshot();
    if (folderTrustScreenVisible(frame.text)) observedTrust = true;
    const buffer = active.terminal.xterm.buffer.active;
    const row = frame.cursorY + buffer.baseY - buffer.viewportY;
    if (
      observedTrust &&
      cursorVisible &&
      frame.cursorX === 2 &&
      /^❯(?:\s|$)/.test(frame.lines[row] ?? "") &&
      /^[─━]{3,}/.test(frame.lines[row - 1] ?? "") &&
      /^[─━]{3,}/.test(frame.lines[row + 1] ?? "") &&
      !folderTrustScreenVisible(frame.text)
    )
      order.push("native-clear");
  });
  // Only physical submission is required; no model response or available quota is needed.
  const pending = active.sendMessage(`Reply exactly ${marker}. Do not use tools.`).then(() => {
    sent = true;
  });
  void pending.catch(() => undefined);
  await waitFor(
    () => {
      const frame = active.terminal.snapshot().text;
      return completeFolderTrustScreenVisible(frame) ? frame : undefined;
    },
    "real Claude human folder-trust dialog",
    25_000,
  );
  await active.terminal.settled();
  assert.equal(active.status, "blocked");
  assert.equal(
    inputs.some((input) => input.includes(marker)),
    false,
  );
  assert.equal(sent, false);
  assert.equal(cursorVisible, false);
  assert.equal(order.length, 0);
  // Native trust can paint before its key handler is live. A human waits for the
  // selection repaint before confirming; never send an arrow into a cleared frame.
  await waitFor(
    async () => {
      const frame = active.terminal.snapshot().text;
      assert.ok(completeFolderTrustScreenVisible(frame), "manual selection remains in trust");
      const affirmative = selectableOptions(frame).find((option) => /\byes\b/i.test(option.label));
      assert.ok(affirmative, "native trust dialog has a human affirmative option");
      if (affirmative.style === "numbered" || affirmative.offset === 0) {
        await active.sendKeys(optionKeystrokes(affirmative)[0]!);
        return true;
      }
      await active.sendKeys(optionKeystrokes(affirmative)[0]!);
      return undefined;
    },
    "visible human affirmative selection",
    5_000,
  );
  try {
    await waitFor(() => (sent ? true : undefined), "queued Claude physical submission", 35_000);
  } catch (error) {
    const frame = active.terminal.snapshot();
    t.diagnostic(
      JSON.stringify({
        status: active.status,
        cursorVisible,
        observedTrust,
        sent,
        inputCount: inputs.length,
        callerInputCount: order.filter((step) => step === "caller-input").length,
        nativeClearCount: order.filter((step) => step === "native-clear").length,
        cursorX: frame.cursorX,
        cursorY: frame.cursorY,
        cols: frame.cols,
        rows: frame.rows,
        renderFailed: active.terminal.renderFailed,
      }),
    );
    throw error;
  }
  await pending;
  assert.equal(order[0], "native-clear");
  assert.ok(order.indexOf("native-clear") < order.indexOf("caller-input"));
  assert.equal(inputs.filter((input) => input.includes(marker)).length, 1);
  const paste = inputs.findIndex((input) => input.includes(marker));
  assert.ok(inputs.slice(paste + 1).includes("\r"), "queued paste has a submitting Enter");
  t.diagnostic(
    "Real Claude PTY: human trust, native visible input cursor, then one queued paste and Enter.",
  );
});
