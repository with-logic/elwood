/** Private question cursor style follows completed native terminal cells (PRD §4). */
import { expect, test } from "vitest";
import { questionCursorProvenance } from "../../../src/core/questions/cursor-provenance.ts";
import { currentRenderedFrame } from "../../../src/terminal/cursor.ts";
import { createHeadlessTerminal } from "../../../src/terminal/headless.ts";

test("C-TRUST-01 placeholder style and Unicode prefix come from the same completed frame", async () => {
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
test("C-TRUST-01 deferred wrap has a complete prefix but no cursor-cell style", async () => {
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
