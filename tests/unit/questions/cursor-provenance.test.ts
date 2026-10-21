/** Private question cursor style follows completed native terminal cells (PRD §4). */
import { expect, test } from "vitest";
import { questionCursorProvenance } from "../../../src/core/questions/cursor-provenance.ts";
import { readQuestionFrame } from "../../../src/core/questions/input.ts";
import { currentRenderedFrame } from "../../../src/terminal/cursor.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";

test("placeholder style and Unicode prefix come from the same completed frame", async () => {
  const terminal = createHeadlessTerminal({ cols: 30, rows: 3 }, () => undefined);
  try {
    await terminal.writeOutput("  \x1b[2mType your answer\x1b[0m\x1b[1;3H");
    const empty = currentRenderedFrame(terminal)!;
    const captured = questionCursorProvenance(terminal, empty);
    expect(captured).toEqual({ cursorCellDimmed: true, cursorLineBefore: "  " });
    await terminal.writeOutput("\x1b[2J\x1b[H  界🦊Type your answer");
    const typed = currentRenderedFrame(terminal)!;
    expect(questionCursorProvenance(terminal, typed)).toEqual({
      cursorCellDimmed: false,
      cursorLineBefore: "  界🦊Type your answer",
    });
    expect(captured).toEqual({ cursorCellDimmed: true, cursorLineBefore: "  " });
  } finally {
    terminal.dispose();
  }
});
test("deferred wrap retains a physical row prefix without cursor-cell style", async () => {
  const terminal = createHeadlessTerminal({ cols: 5, rows: 3 }, () => undefined);
  try {
    await terminal.writeOutput("abcde");
    const frame = currentRenderedFrame(terminal)!;
    expect(frame.cursorX).toBe(frame.cols);
    expect(questionCursorProvenance(terminal, frame)).toEqual({ cursorLineBefore: "abcde" });
  } finally {
    terminal.dispose();
  }
});

test("an unavailable cursor row returns no provenance", async () => {
  const terminal = createHeadlessTerminal({ cols: 30, rows: 3 }, () => undefined);
  try {
    await terminal.writeOutput("answer");
    const frame = currentRenderedFrame(terminal)!;
    expect(questionCursorProvenance(terminal, { ...frame, cursorY: frame.rows })).toEqual({});
  } finally {
    terminal.dispose();
  }
});

test("question frames retain same-render cursor provenance across scrollback offsets", async () => {
  const terminal = createHeadlessTerminal({ cols: 30, rows: 4 }, () => undefined);
  try {
    await terminal.writeOutput(
      `${Array.from({ length: 10 }, (_, index) => `line-${index}`).join("\r\n")}\x1b[2;1H\x1b[2K  \x1b[2mType your answer\x1b[0m\x1b[2;3H\x1b[?25h`,
    );
    terminal.xterm.scrollLines(-2);
    expect(terminal.xterm.buffer.active.baseY).toBe(6);
    expect(terminal.xterm.buffer.active.viewportY).toBe(4);
    const lines = ["line-4", "line-5", "line-6", "  Type your answer"];
    expect(readQuestionFrame(terminal)).toEqual({
      cols: 30,
      rows: 4,
      cursorX: 2,
      cursorY: 1,
      lines,
      text: lines.join("\n"),
      cursorRow: 3,
      cursorVisible: true,
      cursorCellDimmed: true,
      cursorLineBefore: "  ",
    });
  } finally {
    terminal.dispose();
  }
});
