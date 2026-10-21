/** Convert buffer-relative cursor positions to snapshot viewport rows (PRD §4.1/§5.3). */
/** Zero-based viewport row: cursorY=3, baseY=10, viewportY=8 gives row 5. */
export function cursorViewportRow(
  cursorY: number,
  buffer: { readonly baseY: number; readonly viewportY: number },
): number {
  return cursorY + buffer.baseY - buffer.viewportY;
}
