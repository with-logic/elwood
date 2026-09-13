/**
 * Aligned, header-first text tables for the listing commands.
 * Implements PRD §12A.8/§12A.10 and C-CLI-24/C-CLI-26.
 */

/** Render a left-aligned table; every cell is one line, columns are two spaces apart. */
export function renderTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = header.map((title, column) =>
    rows.reduce((width, row) => Math.max(width, (row[column] ?? "").length), title.length),
  );
  const line = (cells: readonly string[]) =>
    widths
      .map((width, column) => (cells[column] ?? "").padEnd(width))
      .join("  ")
      .trimEnd();
  return `${[line(header), ...rows.map(line)].join("\n")}\n`;
}
