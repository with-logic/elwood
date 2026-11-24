/** Captures terminal rows and live-buffer cursor coordinates synchronously (PRD §4.1/§5.3). */
import type { TerminalSize } from "../core/types.ts";
import type { TerminalSnapshot, XtermTerminal } from "./headless.ts";

export function terminalSnapshot(
  xterm: XtermTerminal,
  size: TerminalSize,
  firstBufferRow = xterm.buffer.active.viewportY,
): TerminalSnapshot {
  const buffer = xterm.buffer.active;
  const lines = Array.from(
    { length: size.rows },
    (_, index) => buffer.getLine(firstBufferRow + index)?.translateToString(true) ?? "",
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
