/**
 * Parses numbered and cursor-selected options from rendered terminal prompts,
 * and exposes the option/non-option split that trust HEADER matching anchors on.
 * Implements PRD §5.1/§5.3/§5.5: shared option parsing for trust automation,
 * Codex composer clearance, and update-prompt skipping. One grammar keeps those
 * consumers consistent across CLI layout changes. `nonOptionText` is shared by the
 * responder and screen-fact blocking rules, so option text cannot spoof a header.
 */

import { arrowDown } from "./input/constants.ts";

export type NumberedOption = { readonly number: string; readonly label: string };

/** One answerable option, with style-specific selection data. */
export type SelectableOption =
  | {
      readonly style: "numbered";
      readonly label: string;
      readonly number: string;
      /** The row carries the list's caret: Enter alone would confirm this option. */
      readonly selected?: true;
    }
  | {
      readonly style: "cursor";
      readonly label: string;
      /** Rows from the rendered cursor to this option (negative above it). */
      readonly offset: number;
      /** Absolute row within the cursor block; Home lands on index 0. */
      readonly index: number;
    };

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
  return ["home", ...new Array<string>(option.index).fill("down"), "enter"].join("+");
}

/**
 * Absolute cursor selection: Home, then one Down per row above the option. Unlike a
 * relative arrow, it lands on the same row however often it repeats and whatever the
 * cursor was on, so a delayed or duplicated write cannot move past the option.
 */
export function cursorSelection(option: Extract<SelectableOption, { style: "cursor" }>): string {
  return `\u001b[H${arrowDown.repeat(option.index)}`;
}

/**
 * Raw PTY writes that answer `option` from the rendered frame: the number, or (when the
 * cursor is elsewhere) the bare selection followed by selection+Enter as ONE write.
 */
export function optionKeystrokes(option: SelectableOption): readonly string[] {
  if (option.style === "numbered") return [`${option.number}\r`];
  const select = cursorSelection(option);
  return option.offset === 0 ? [`${select}\r`] : [select, `${select}\r`];
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
    const caret = /^\s*[❯›>]\s*\d+[.)]/.test(line);
    return [...matches].map((match, index) => {
      return {
        row,
        style: "numbered" as const,
        label: (match[2] as string).trim(),
        number: match[1] as string,
        ...(caret && index === 0 ? { selected: true as const } : {}),
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
 * header cannot register as its own candidate region. `startRow` bounds a resumed
 * scan without copying or revisiting an already classified prefix.
 */
export function cursorOptionRows(
  lines: readonly string[],
  startRow = 0,
): { readonly firstRow: number; readonly lastRow: number } | undefined {
  const bounds = cursorOptionBounds(lines, startRow);
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
      index,
    };
  });
}

function cursorOptionBounds(lines: readonly string[], startRow = 0) {
  const cursorPattern = /^(\s*)[❯›](\s+)(?!\d+[.)]\s)(\S.*)$/;
  let selected: RegExpExecArray | undefined;
  let selectedRow = -1;
  for (let row = startRow; row < lines.length; row++) {
    const match = cursorPattern.exec(lines[row] as string);
    if (match === null) continue;
    selected = match;
    selectedRow = row;
    break;
  }
  if (selected === undefined) return undefined;
  const labelColumn = (selected[1] as string).length + 1 + (selected[2] as string).length;
  let firstRow = selectedRow;
  while (firstRow > startRow && cursorSiblingLabel(lines[firstRow - 1] as string, labelColumn))
    firstRow--;
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
