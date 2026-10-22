/** Capture private editor cursor evidence from the same completed frame (PRD §4). */
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";
import type { QuestionFrame } from "./adapter.ts";

/**
 * Call with this terminal's completed snapshot, before any intervening render.
 * The prefix covers only the physical cursor row before cursorX, not a complete
 * logical answer: clipped or multirow text cannot be reconstructed from it.
 * Cursor-cell dimming is omitted when no cell is addressable (including deferred
 * wrap); an unavailable row leaves both provenance fields absent.
 */
export function questionCursorProvenance(
  terminal: ElwoodTerminal,
  frame: TerminalSnapshot,
): Pick<QuestionFrame, "cursorCellDimmed" | "cursorLineBefore"> {
  const buffer = terminal.xterm.buffer.active;
  const row = buffer.getLine(buffer.baseY + frame.cursorY);
  if (row === undefined) return {};
  const cell = row.getCell(frame.cursorX);
  return {
    cursorLineBefore: row.translateToString(false, 0, frame.cursorX),
    ...(cell === undefined ? {} : { cursorCellDimmed: Boolean(cell.isDim()) }),
  };
}
