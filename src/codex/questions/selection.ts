/** Parse dense native option selection without pasted editor rows (PRD §4, §5.10). */
import { displayColumns } from "../screen/display-columns.ts";

const optionRow = /^\s*(?:› )?\d+\. /;
// An option row up to its description: indent, caret, number, label and the gap of two or more
// spaces Codex pads labels with.
const beforeDescription = /^(\s*(?:› )?\d+\. .*?\S {2,})\S/;

/**
 * Panel rows with each option's wrapped description folded into its row. A pane too narrow for an
 * option's description wraps it onto rows indented to the column where the description starts.
 * `raw` holds the same rows as drawn, when `rows` are trimmed, and gives their indentation.
 */
export function foldOptionRows(
  rows: readonly string[],
  raw: readonly string[] = rows,
): readonly string[] {
  const folded: string[] = [];
  let descriptionColumn: number | undefined;
  for (const [index, row] of rows.entries()) {
    const drawn = raw[index]!;
    const text = row.trim();
    const indent = drawn.length - drawn.trimStart().length;
    const last = folded.at(-1);
    if (
      last !== undefined &&
      text !== "" &&
      indent === descriptionColumn &&
      !optionRow.test(drawn)
    ) {
      folded[folded.length - 1] = `${last.trimEnd()} ${text}`;
      continue;
    }
    folded.push(row);
    const prefix = beforeDescription.exec(drawn)?.[1];
    descriptionColumn = prefix === undefined ? undefined : displayColumns(prefix);
  }
  return folded;
}

export function nativeSelection(body: readonly string[], paged: boolean): number | undefined {
  const content = foldOptionRows(body).filter((line) => line.trim().length > 0);
  const rows = content.slice(paged ? 2 : 1);
  let count = 0;
  let selected: number | undefined;
  for (const line of rows) {
    const match = /^ {2}(› | {2})(\d+)\. /.exec(line);
    if (!match || Number(match[2]) !== count + 1) break;
    if (match[1] === "› ") selected = count;
    count += 1;
  }
  // Native queued choices include Other; modal choices include None of the above.
  return count > 1 ? selected : undefined;
}
