/** Capture private editor cursor evidence from the same completed frame (PRD §4). */
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import type { QuestionFrame } from "./adapter.ts";

export function questionCursorProvenance(
  terminal: ElwoodTerminal,
  frame: TerminalSnapshot,
): Pick<QuestionFrame, "cursorCellDimmed" | "cursorLineBefore"> {
  const buffer = terminal.xterm.buffer.active;
  // A completed terminal snapshot has a native cursor row, including deferred wraps.
  const row = buffer.getLine(buffer.baseY + frame.cursorY)!;
  const cell = row.getCell(frame.cursorX);
  return {
    cursorLineBefore: row.translateToString(false, 0, frame.cursorX),
    ...(cell === undefined ? {} : { cursorCellDimmed: Boolean(cell.isDim()) }),
  };
}
