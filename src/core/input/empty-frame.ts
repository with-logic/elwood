/** Positive native input geometry, independent of turn activity (PRD §5.3, C-API-56). */
import { cursorViewportRow } from "../../terminal/coordinates.ts";
import { currentRenderedFrame, settledCursorVisible } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";

/** The caller separately owns dialog blocking; this only observes the current input surface. */
export function emptyInputFrame(
  terminal: ElwoodTerminal,
  matches: (rows: readonly string[], cursorRow: number) => boolean,
  location: "viewport" | "live" = "viewport",
): TerminalSnapshot | undefined {
  const frame = currentRenderedFrame(terminal, location);
  // Both native inputs place the caret after the two-cell "❯ " / "› " prefix.
  if (!(frame && settledCursorVisible(terminal.xterm)) || frame.cursorX !== 2) return undefined;
  const buffer = terminal.xterm.buffer.active;
  // The public viewport can begin earlier in the buffer than cursorY's origin.
  const cursorRow = location === "live" ? frame.cursorY : cursorViewportRow(frame.cursorY, buffer);
  return matches(frame.lines, cursorRow) ? frame : undefined;
}
