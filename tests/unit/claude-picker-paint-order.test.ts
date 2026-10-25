/**
 * Claude 2.1.310 paints its picker top-down, the `… +K models` line before the footer, so a
 * frame that reads as the complete picker always states the whole list's length. Replays the
 * real opening on row 10, the one place a frame without its count would read as a complete
 * ten-row list, over a placeholder screen with the captured layout (PRD §5.3, C-API-23).
 */
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { isOwnCompletePicker } from "../../src/core/models/own-picker.ts";
import type { ParsedModelPicker } from "../../src/core/models/rows.ts";
import { createHeadlessTerminal } from "../../src/terminal/headless.ts";

type Capture = {
  readonly cols: number;
  readonly rows: number;
  readonly cursor: { readonly x: number; readonly y: number };
  /** The screen under the picker, every character replaced: only its layout is real. */
  readonly screen: readonly string[];
  /** The real bytes from the erase of the slash-command menu to the first key. */
  readonly paint: string;
};

const capture: Capture = JSON.parse(
  readFileSync(
    new URL("../fixtures/claude-2.1.310/model-picker/opening-on-row-10.json", import.meta.url),
    "utf8",
  ),
);
const ownCompletePicker = isOwnCompletePicker(claudeModelPicker);

const listLength = (frame: ParsedModelPicker) =>
  frame.hiddenRowCountBelow === undefined
    ? undefined
    : Math.max(...frame.rows.map((row) => row.absoluteRowNumber)) + frame.hiddenRowCountBelow;

test("C-API-23 every complete frame of Claude's opening on row 10 states the whole list", async () => {
  const terminal = createHeadlessTerminal(capture, () => undefined);
  try {
    const { x, y } = capture.cursor;
    await terminal.writeOutput(`\u001b[H${capture.screen.join("\r\n")}\u001b[${y + 1};${x + 1}H`);
    // The footer is the last thing painted, and the complete picker needs it, so no frame
    // before its first byte can be complete. The count's bytes come earlier.
    const footer = capture.paint.indexOf("Esc to c");
    expect(capture.paint.slice(0, footer)).toContain("… +3 models");
    await terminal.writeOutput(capture.paint.slice(0, footer));
    expect(ownCompletePicker(terminal.snapshot().text)).toBe(false);
    const lengths = new Set<number | undefined>();
    for (const unit of capture.paint.slice(footer)) {
      await terminal.writeOutput(unit);
      const text = terminal.snapshot().text;
      if (ownCompletePicker(text)) lengths.add(listLength(claudeModelPicker.parse(text)));
    }
    expect([...lengths]).toEqual([13]);
    const opened = claudeModelPicker.parse(terminal.snapshot().text);
    expect(opened.rows[opened.cursorOptionIndex]?.absoluteRowNumber).toBe(10);
    expect(opened.rows.map((row) => row.absoluteRowNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  } finally {
    terminal.dispose();
  }
});
