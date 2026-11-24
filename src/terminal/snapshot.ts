/** Captures viewport text and cursor coordinates synchronously (PRD §4.1/§5.3). */
import type { TerminalSize } from "../core/types.ts";
import type { TerminalSnapshot, XtermTerminal } from "./headless.ts";

export function terminalSnapshot(
  xterm: XtermTerminal,
  size: TerminalSize,
  top = xterm.buffer.active.viewportY,
): TerminalSnapshot {
  const buffer = xterm.buffer.active;
  const lines = Array.from(
    { length: size.rows },
    (_, index) => buffer.getLine(top + index)?.translateToString(true) ?? "",
  );
  return {
    cols: size.cols,
    rows: size.rows,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    lines,
    text: lines.join("\n"),
  };
}
