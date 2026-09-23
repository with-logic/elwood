/** Positive native input geometry, independent of turn activity (PRD §5.3, C-API-56). */
import { currentRenderedFrame, settledCursorVisible } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";

/** The caller separately owns dialog blocking; this only observes the current input surface. */
export function emptyInputFrame(
  terminal: ElwoodTerminal,
  matches: (rows: readonly string[], cursorRow: number) => boolean,
): TerminalSnapshot | undefined {
  const frame = currentRenderedFrame(terminal);
  if (!(frame && settledCursorVisible(terminal.xterm)) || frame.cursorX !== 2) return undefined;
  const buffer = terminal.xterm.buffer.active;
  const row = frame.cursorY + buffer.baseY - buffer.viewportY;
  return matches(frame.lines, row) ? frame : undefined;
}
