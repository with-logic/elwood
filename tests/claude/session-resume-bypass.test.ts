/**
 * A Claude session resumed with `highTrust` in a config that never accepted bypass mode
 * answers the bypass-permissions dialog and reaches `ready` (C-CLAUDE-21, C-API-28),
 * replayed from Claude Code 2.1.310's own frames
 * (`tests/fixtures/claude-2.1.310/resume-bypass/`, see the README). Once the dialog is
 * accepted, the resumed transcript above the composer still shows the earlier prompt
 * Claude echoed as `❯ <prompt>`.
 */

import { afterEach, expect, test } from "vitest";
import { resumeClaude, startClaude } from "../../src/index.ts";
import { readNativeInputFrame } from "../fixtures/native-input-frame.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

type NativeFrame = ReturnType<typeof readNativeInputFrame>;
const capture = (name: string) =>
  readNativeInputFrame(
    new URL(`../fixtures/claude-2.1.310/resume-bypass/${name}.json`, import.meta.url),
  );
const dialog = capture("dialog");
const accepted = capture("accepted");
// The dialog after Home+Down: its caret on `Yes, I accept`.
const selected: NativeFrame = {
  ...dialog,
  text: dialog.text
    .replace("  ❯ No, exit", "    No, exit")
    .replace("    Yes, I accept", "  ❯ Yes, I accept"),
};
const selectAccept = "\u001b[H\u001b[B";

/** The bytes that repaint `frame` whole: its rows, cursor, cursor visibility, and title. */
const paint = (frame: NativeFrame) =>
  `\u001b[2J\u001b[H${frame.text.replaceAll("\n", "\r\n")}` +
  `\u001b[${frame.cursorY + 1};${frame.cursorX + 1}H\u001b[?25${frame.visible ? "h" : "l"}` +
  `\u001b]0;${frame.title}\u0007`;

test("C-CLAUDE-21 a highTrust resume answers the bypass dialog and is ready above its transcript", async () => {
  expect(accepted.text).toMatch(/^❯ Reply with exactly: hello\./m);
  installFakes();
  const cwd = tempDir();
  const initialSize = { cols: dialog.cols, rows: dialog.rows };
  const original = await startClaude({ cwd, initialSize });
  await ptys[0]!.dispatchHook(original.elwoodSessionId, {
    hook_event_name: "SessionStart",
    session_id: "claude-resume",
    cwd,
    source: "startup",
    model: "fixture",
  });
  await original.stop();
  const session = await resumeClaude({
    cwd,
    elwoodSessionId: original.elwoodSessionId,
    highTrust: true,
    autotrust: true,
    initialSize,
  });
  try {
    const pty = ptys[1]!;
    pty.emitData(paint(dialog));
    await expect.poll(() => pty.writes).toEqual([selectAccept]);
    pty.emitData(paint(selected));
    await expect.poll(() => pty.writes).toEqual([selectAccept, `${selectAccept}\r`]);
    pty.emitData(paint(accepted));
    await session.terminal.settled();
    await expect.poll(() => session.status).toBe("ready");
  } finally {
    await session.teardown();
  }
});
