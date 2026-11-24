/** Positive native input geometry, independent of turn activity (PRD §5.3, C-API-56). */
import { settledCursorVisible, settledLiveSnapshot } from "../../terminal/cursor.ts";
import type { ElwoodTerminal, TerminalSnapshot } from "../../terminal/headless.ts";

/** The caller separately owns dialog blocking; this only observes the current input surface. */
export function emptyInputFrame(
  terminal: ElwoodTerminal,
  matches: (rows: readonly string[], cursorRow: number) => boolean,
): TerminalSnapshot | undefined {
  const frame = settledLiveSnapshot(terminal);
  // Both native inputs place the caret after the two-cell "❯ " / "› " prefix.
  if (!(frame && settledCursorVisible(terminal.xterm)) || frame.cursorX !== 2) return undefined;
  return matches(frame.lines, frame.cursorY) ? frame : undefined;
}
