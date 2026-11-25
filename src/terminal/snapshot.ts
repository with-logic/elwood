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

/** Verify that a native target row leaves enough padding for a complete path. */
export function nativePathRowFits(
  xterm: XtermTerminal,
  row: number,
  rightInset: number,
  allowAsciiPadding = false,
): boolean {
  const buffer = xterm.buffer.active;
  const line = buffer.getLine(buffer.baseY + row);
  if (!line || line.isWrapped || buffer.getLine(buffer.baseY + row + 1)?.isWrapped) return false;
  const end = xterm.cols - rightInset;
  return [end - 2, end - 1].every((col) => {
    const cell = line.getCell(col);
    if (cell?.getWidth() !== 1) return false;
    const chars = cell.getChars();
    return chars === "" || (allowAsciiPadding && chars === " ");
  });
}
