/**
 * Parses numbered and cursor-selected options from rendered terminal prompts,
 * and exposes the option/non-option split that trust HEADER matching anchors on.
 * Implements PRD §5.1/§5.5: the single option-parsing rule shared by trust-prompt
 * automation and Codex update-prompt skipping, so a CLI format change updates
 * both at once instead of letting them diverge. `nonOptionText` is shared by the
 * responder and screen-fact blocking rules, so option text cannot spoof a header.
 */

export type NumberedOption = { readonly number: string; readonly label: string };

/** One answerable option, with style-specific selection data. */
export type SelectableOption =
  | { readonly style: "numbered"; readonly label: string; readonly number: string }
  | { readonly style: "cursor"; readonly label: string; readonly offset: number };

type Position = { readonly row: number };
type PositionedNumberedOption = Extract<SelectableOption, { readonly style: "numbered" }> &
  Position;
type PositionedCursorOption = Extract<SelectableOption, { readonly style: "cursor" }> & Position;

/** Extracts `N. label` / `N) label` options from `text`, tolerating `›`/`>` prefixes. */
export function numberedOptions(text: string): readonly NumberedOption[] {
  return positionedNumberedOptions(text.split("\n")).map(({ number, label }) => ({
    number,
    label,
  }));
}

/** Numbered and cursor-style options in screen order. */
export function selectableOptions(text: string): readonly SelectableOption[] {
  const lines = text.split("\n");
  return [...positionedNumberedOptions(lines), ...positionedCursorOptions(lines)]
    .sort((a, b) => a.row - b.row)
    .map(({ row: _row, ...option }) => option);
}

/** Bounded, printable selection description used in startup-prompt activity. */
export function optionInput(option: SelectableOption): string {
  if (option.style === "numbered") return option.number;
  if (option.offset === 0) return "enter";
  const direction = option.offset < 0 ? "up" : "down";
  return `${`${direction}+`.repeat(Math.abs(option.offset))}enter`;
}

/** Raw PTY writes for a numbered option or cursor movement plus confirmation. */
export function optionKeystrokes(option: SelectableOption): readonly string[] {
  if (option.style === "numbered") return [`${option.number}\r`];
  const key = option.offset < 0 ? "\u001b[A" : "\u001b[B";
  return [...new Array<string>(Math.abs(option.offset)).fill(key), "\r"];
}

/**
 * The frame's HEADER text: everything strictly before the first numbered option
 * or cursor-option block. Cutting at the whole cursor block (including unselected
 * rows above its caret) keeps option-only trust wording and wrapped continuations
 * out of header recognition. With no option yet, the whole partial frame remains
 * matchable so a later completed frame can still be answered.
 */
export function nonOptionText(frame: string): string {
  const lines = frame.split("\n");
  const numberedRow = firstNumberedRow(lines);
  const cursorRow = cursorOptionBounds(lines)?.firstRow;
  const firstOption = Math.min(numberedRow ?? lines.length, cursorRow ?? lines.length);
  return lines.slice(0, firstOption).join(" ");
}

function positionedNumberedOptions(lines: readonly string[]): readonly PositionedNumberedOption[] {
  return lines.flatMap((line, row) => {
    const matches = line.matchAll(/(?:^|[\s›>])(\d+)[.)]\s*(.+?)(?=\s*\d+[.)]\s*|$)/g);
    return [...matches].map((match) => {
      return {
        row,
        style: "numbered" as const,
        label: (match[2] as string).trim(),
        number: match[1] as string,
      };
    });
  });
}

function firstNumberedRow(lines: readonly string[]): number | undefined {
  const pattern = /(?:^|[\s›>])\d+[.)]\s*\S/;
  const row = lines.findIndex((line) => pattern.test(line));
  return row < 0 ? undefined : row;
}

/**
 * Inclusive row span of the frame's cursor-option block, or `undefined` when it has
 * none. Header scanning excludes these rows so an option label that reads like a
 * header cannot register as its own candidate region.
 */
export function cursorOptionRows(
  lines: readonly string[],
): { readonly firstRow: number; readonly lastRow: number } | undefined {
  const bounds = cursorOptionBounds(lines);
  return bounds && { firstRow: bounds.firstRow, lastRow: bounds.lastRow };
}

function positionedCursorOptions(lines: readonly string[]): readonly PositionedCursorOption[] {
  const bounds = cursorOptionBounds(lines);
  if (bounds === undefined) return [];
  const { selected, selectedRow, firstRow, lastRow } = bounds;
  return lines.slice(firstRow, lastRow + 1).map((line, index) => {
    const row = firstRow + index;
    return {
      row,
      style: "cursor" as const,
      label: row === selectedRow ? (selected[3] as string).trim() : line.trim(),
      offset: row - selectedRow,
    };
  });
}

function cursorOptionBounds(lines: readonly string[]) {
  const cursorPattern = /^(\s*)[❯›](\s+)(?!\d+[.)]\s)(\S.*)$/;
  let selected: RegExpExecArray | undefined;
  let selectedRow = -1;
  for (const [row, line] of lines.entries()) {
    const match = cursorPattern.exec(line);
    if (match === null) continue;
    selected = match;
    selectedRow = row;
    break;
  }
  if (selected === undefined) return undefined;
  const labelColumn = (selected[1] as string).length + 1 + (selected[2] as string).length;
  let firstRow = selectedRow;
  while (firstRow > 0 && cursorSiblingLabel(lines[firstRow - 1] as string, labelColumn)) firstRow--;
  let lastRow = selectedRow;
  while (
    lastRow + 1 < lines.length &&
    cursorSiblingLabel(lines[lastRow + 1] as string, labelColumn)
  )
    lastRow++;
  return { selected, selectedRow, labelColumn, firstRow, lastRow };
}

function cursorSiblingLabel(line: string, labelColumn: number): boolean {
  const match = /^(\s*)(\S.*)$/.exec(line);
  return match !== null && (match[1] as string).length === labelColumn;
}
