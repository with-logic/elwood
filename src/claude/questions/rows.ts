/** Parse exact Claude question rows and their native checkbox state (PRD §4). */
import type { QuestionDefinition } from "../../core/questions/types.ts";

export const claudeQuestionRow =
  /^(?<marker>❯| ) (?<number>\d+)\. (?:\[(?<checkbox>[ ✔])\] )?(?<label>.*)$/;
export const OTHER_CONTINUATION_INDENT_COLUMNS = 5;
export const normalizeClaudeQuestionText = (text: string) => text.replace(/\s+/g, " ").trim();
export type ClaudeQuestionRows = {
  /** Zero-based selection-list index: options, Other, then optional Submit. */
  readonly cursor: number;
  /** Checkbox state for each option and the Other row. */
  readonly checked: readonly boolean[];
  readonly other: string;
  /** Inclusive zero-based offset of the first Other row within the parsed row slice. */
  readonly otherStart: number;
  /** Inclusive zero-based offset of the last Other row within the parsed row slice. */
  readonly otherEnd: number;
};

/** Parse a complete row slice; return undefined for mismatched or incomplete native rows. */
export function parseClaudeQuestionRows(
  question: QuestionDefinition,
  questionRows: readonly string[],
): ClaudeQuestionRows | undefined {
  const parsed = questionRows
    .map((line, index) => ({ index, match: claudeQuestionRow.exec(line) }))
    .filter((item) => item.match);
  if (parsed.length !== question.options.length + 1) return undefined;
  const checked: boolean[] = [];
  let cursor = -1;
  for (const [index, item] of parsed.entries()) {
    const match = item.match!;
    if (!matchesQuestionRow(question, index, match)) return undefined;
    const next = parsed[index + 1];
    if (
      next &&
      !descriptionMatches(
        question.options[index]!.description,
        questionRows.slice(item.index + 1, next.index),
      )
    )
      return undefined;
    checked.push(match.groups!["checkbox"] === "✔");
    if (match.groups!["marker"] === "❯") cursor = index;
  }
  const last = parsed.at(-1)!;
  const next =
    question.selection === "multiple"
      ? questionRows.findIndex(
          (line, index) => index > last.index && /^(?:❯| ) {4}Submit$/.test(line),
        )
      : -1;
  if (question.selection === "multiple") {
    if (next < 0 || questionRows.slice(next + 1).some((line) => line.trim())) return undefined;
    if (questionRows[next]!.trimStart().startsWith("❯")) cursor = parsed.length;
  }
  if (cursor < 0) return undefined;
  const other = [
    last.match!.groups!["label"]!,
    ...questionRows
      .slice(last.index + 1, next < 0 ? undefined : next)
      .map((line) => line.slice(OTHER_CONTINUATION_INDENT_COLUMNS)),
  ].join("\n");
  return {
    cursor,
    checked,
    other,
    otherStart: last.index,
    otherEnd: next < 0 ? questionRows.length - 1 : next - 1,
  };
}

function descriptionMatches(description: string | undefined, rows: readonly string[]): boolean {
  return (
    normalizeClaudeQuestionText(rows.join("\n")) === normalizeClaudeQuestionText(description ?? "")
  );
}

function matchesQuestionRow(
  question: QuestionDefinition,
  index: number,
  match: RegExpExecArray,
): boolean {
  const { number, label, checkbox } = match.groups!;
  const numberMatches = Number(number) === index + 1;
  const isOtherRow = index >= question.options.length;
  const labelMatches = isOtherRow || label === question.options[index]!.label;
  const needsCheckbox = question.selection === "multiple";
  const hasCheckbox = checkbox !== undefined;
  const checkboxMatches = needsCheckbox === hasCheckbox;
  return numberMatches && labelMatches && checkboxMatches;
}
