/** Native question coordinates and visibility belong to one viewport (PRD §4.1). */
import { expect, test } from "vitest";
import { readQuestionFrame } from "../../../src/core/questions/input.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";

test("scrollback maps the native cursor to its visible snapshot row and retains visibility", async () => {
  const terminal = createHeadlessTerminal({ cols: 30, rows: 4 }, () => {});
  try {
    await terminal.writeOutput(
      `${Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\r\n")}\x1b[2;3H\x1b[?25h`,
    );
    terminal.xterm.scrollLines(-2);
    const buffer = terminal.xterm.buffer.active;
    expect(buffer.baseY - buffer.viewportY).toBe(2);
    const current = readQuestionFrame(terminal)!;
    expect(current.cursorY).toBe(1);
    expect(current.cursorRow).toBe(3);
    expect(current.lines[current.cursorRow]).toContain("line-7");
    expect(current.cursorVisible).toBe(true);
    await terminal.writeOutput("\x1b[?25l");
    expect(readQuestionFrame(terminal)?.cursorVisible).toBe(false);
    await terminal.writeOutput("\x1b[?25h");
    expect(readQuestionFrame(terminal)?.cursorVisible).toBe(true);
  } finally {
    terminal.dispose();
  }
});
