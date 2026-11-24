/** Read Claude's native input cursor from a settled composer frame (PRD §5.4, C-TRUST-01). */
import { settledCursorVisible } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";

/** Zero-based input position after Claude's two-cell "❯ " composer prefix. */
export const claudeComposerInputColumn = 2;

export function claudeComposerCursor(
  terminal: ElwoodTerminal,
  frame: TerminalSnapshot,
): "hardware" | "software" | undefined {
  if (frame.cursorX !== claudeComposerInputColumn) return undefined;
  if (settledCursorVisible(terminal.xterm)) return "hardware";
  if (frame.lines[frame.cursorY]?.trimEnd() !== "❯") return undefined;
  // Claude 2.1.331 can hide the hardware cursor and draw a reverse-video space.
  const buffer = terminal.xterm.buffer.active;
  const cell = buffer.getLine(buffer.baseY + frame.cursorY)?.getCell(frame.cursorX);
  return cell?.getChars() === " " && cell.isInverse() !== 0 ? "software" : undefined;
}
