/** Read native option rows: fold wrapped descriptions into their options and parse the selection (PRD §4, §5.10). */
import { displayColumns } from "../screen/display-columns.ts";

// Codex draws an option row from column 2: a caret or two spaces, then the option's number.
// Groups: the caret or its blank, and the number.
const optionRow = /^ {2}(› | {2})(\d+)\. /;

/** The columns where an option row's text resumes after each gap of two or more spaces. */
function gapEnds(row: string): readonly number[] {
  const optionPrefix = optionRow.exec(row)?.[0];
  if (optionPrefix === undefined) return [];
  return [...row.slice(optionPrefix.length).matchAll(/ {2,}(?=\S)/g)].map((gap) =>
    displayColumns(row.slice(0, optionPrefix.length + gap.index + gap[0].length)),
  );
}

/**
 * Drawn panel rows with each option's wrapped description joined to its option row by a newline.
 * Codex pads labels so every description starts in one column, the gap end all described options
 * share, and wraps a description too long for its row onto rows indented to that column.
 */
export function foldOptionRows(rows: readonly string[]): readonly string[] {
  const parsed = rows.map((row) => ({ row, ends: gapEnds(row) }));
  const described = parsed.filter(({ ends }) => ends.length > 0);
  const column = described[0]?.ends.find((end) =>
    described.every(({ ends }) => ends.includes(end)),
  );
  const folded: string[] = [];
  let describedAbove = false;
  for (const { row, ends } of parsed) {
    const text = row.trim();
    const last = folded.at(-1);
    const indent = row.length - row.trimStart().length;
    if (last !== undefined && describedAbove && text !== "" && indent === column) {
      folded[folded.length - 1] = `${last.trimEnd()}\n${text}`;
      continue;
    }
    folded.push(row);
    describedAbove = column !== undefined && ends.includes(column);
  }
  return folded;
}

/**
 * Whether a folded description reads as `text`. Each row break stood for the space the terminal
 * wrapped at or, inside a word too long for its row, for nothing.
 */
export function readsAsWrapped(shown: string, text: string): boolean {
  let rest = text;
  for (const [index, row] of shown.split("\n").entries()) {
    if (index > 0 && rest.startsWith(" ")) rest = rest.slice(1);
    if (!rest.startsWith(row)) return false;
    rest = rest.slice(row.length);
  }
  return rest === "";
}

/**
 * The zero-based index of the option the caret is on, or undefined when no caret is on a list of
 * at least two consecutively numbered options. `body` holds the panel rows as drawn, untrimmed:
 * a wrapped description is known by its indentation. The options follow the prompt row and,
 * when `paged` (a queued panel of several questions), the `1 of 3` position row above it.
 */
export function nativeSelection(body: readonly string[], paged: boolean): number | undefined {
  const content = foldOptionRows(body).filter((line) => line.trim().length > 0);
  const rows = content.slice(paged ? 2 : 1);
  let count = 0;
  let selected: number | undefined;
  for (const line of rows) {
    const match = optionRow.exec(line);
    if (!match || Number(match[2]) !== count + 1) break;
    if (match[1] === "› ") selected = count;
    count += 1;
  }
  // Native queued choices include Other; modal choices include None of the above.
  return count > 1 ? selected : undefined;
}
