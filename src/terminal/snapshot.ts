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

/**
 * Checks for two width-one padding cells before the right inset of an unwrapped
 * live row. The caller verifies the path itself.
 */
export function hasUnwrappedRowEndPadding(
  xterm: XtermTerminal,
  row: number,
  rightInset: number,
  allowAsciiPadding = false,
): boolean {
  const buffer = xterm.buffer.active;
  const line =
    Number.isInteger(row) && row >= 0 && row < xterm.rows
      ? buffer.getLine(buffer.baseY + row)
      : undefined;
  if (!line || line.isWrapped) return false;
  const next = row + 1 < xterm.rows ? buffer.getLine(buffer.baseY + row + 1) : undefined;
  if (next?.isWrapped) return false;
  const end = xterm.cols - rightInset;
  return [end - 2, end - 1].every((col) => {
    const cell = line.getCell(col);
    if (cell?.getWidth() !== 1) return false;
    const chars = cell.getChars();
    return chars === "" || (allowAsciiPadding && chars === " ");
  });
}
