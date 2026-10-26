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
import { nativeFrameOutput, readNativeInputFrame } from "../fixtures/native-input-frame.ts";
import { installFakes, ptys, resetFakes, tempDir } from "./helpers.ts";

afterEach(resetFakes);

const capture = (name: "dialog" | "accepted") =>
  readNativeInputFrame(
    new URL(`../fixtures/claude-2.1.310/resume-bypass/${name}.json`, import.meta.url),
  );
const dialog = capture("dialog");
const accepted = capture("accepted");
// The dialog after Home+Down: its caret on `Yes, I accept`.
const selected = {
  ...dialog,
  text: dialog.text
    .replace("  ❯ No, exit", "    No, exit")
    .replace("    Yes, I accept", "  ❯ Yes, I accept"),
};
const selectAccept = "\u001b[H\u001b[B";

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
    pty.emitData(nativeFrameOutput(dialog));
    await expect.poll(() => pty.writes).toEqual([selectAccept]);
    pty.emitData(nativeFrameOutput(selected));
    await expect.poll(() => pty.writes).toEqual([selectAccept, `${selectAccept}\r`]);
    pty.emitData(nativeFrameOutput(accepted));
    await session.terminal.settled();
    await expect.poll(() => session.status).toBe("ready");
  } finally {
    await session.teardown();
  }
});
