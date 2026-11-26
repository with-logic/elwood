/** Captures terminal rows and live-buffer cursor coordinates synchronously (PRD §4.1/§5.3). */
import type { TerminalSize } from "../core/types.ts";
import type { XtermTerminal } from "./headless.ts";

export type TerminalSnapshot = {
  readonly cols: number;
  readonly rows: number;
  readonly cursorX: number;
  /** Zero-based cursor row relative to the live buffer base. */
  readonly cursorY: number;
  /** Rows from the selected viewport in a public snapshot. */
  readonly lines: readonly string[];
  readonly text: string;
};

export function terminalSnapshot(
  xterm: XtermTerminal,
  size: TerminalSize,
  firstBufferRow = xterm.buffer.active.viewportY,
): TerminalSnapshot {
  const buffer = xterm.buffer.active;
  const lines = bufferRows(xterm, { firstRow: firstBufferRow, rowCount: size.rows });
  return {
    cols: size.cols,
    rows: size.rows,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    lines,
    text: lines.join("\n"),
  };
}

/** Which active-buffer rows to read: `rowCount` rows starting at buffer row `firstRow`. */
type BufferRowRange = { readonly firstRow: number; readonly rowCount: number };

/** Right-trimmed text of the requested active-buffer rows; a missing row reads as "". */
export function bufferRows(xterm: XtermTerminal, { firstRow, rowCount }: BufferRowRange): string[] {
  const buffer = xterm.buffer.active;
  return Array.from(
    { length: rowCount },
    (_, index) => buffer.getLine(firstRow + index)?.translateToString(true) ?? "",
  );
}

type RowEndPaddingOptions = {
  /** Zero-based row relative to the active buffer's live base (`baseY`). */
  readonly viewportRow: number;
  /** Columns counted leftward from the terminal's right edge. */
  readonly rightInsetColumns: number;
  readonly allowAsciiPadding?: boolean;
};

/**
 * Checks for two width-one padding cells before the right inset of an unwrapped
 * live row. The caller verifies the path itself.
 */
export function hasUnwrappedRowEndPadding(
  xterm: XtermTerminal,
  { viewportRow, rightInsetColumns, allowAsciiPadding = false }: RowEndPaddingOptions,
): boolean {
  const buffer = xterm.buffer.active;
  const line =
    Number.isInteger(viewportRow) && viewportRow >= 0 && viewportRow < xterm.rows
      ? buffer.getLine(buffer.baseY + viewportRow)
      : undefined;
  if (!line || line.isWrapped) return false;
  const nextRow = viewportRow + 1;
  const next = nextRow < xterm.rows ? buffer.getLine(buffer.baseY + nextRow) : undefined;
  if (next?.isWrapped) return false;
  const end = xterm.cols - rightInsetColumns;
  return [end - 2, end - 1].every((col) => {
    const cell = line.getCell(col);
    if (cell?.getWidth() !== 1) return false;
    const chars = cell.getChars();
    return chars === "" || (allowAsciiPadding && chars === " ");
  });
}
