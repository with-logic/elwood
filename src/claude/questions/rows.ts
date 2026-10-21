/** Parse exact Claude choices and their native checkbox state (PRD §4). */
import type { QuestionDefinition } from "../../core/questions/types.ts";

export const claudeQuestionRow = /^(❯| ) (\d+)\. (?:\[([ ✔])\] )?(.*)$/;
export const normalizeClaudeQuestionText = (text: string) => text.replace(/\s+/g, " ").trim();
export type ClaudeQuestionRows = {
  /** Native cursor destination: options, Other, then optional Submit. */
  readonly cursor: number;
  /** Checkbox state for each option and the Other row. */
  readonly checked: readonly boolean[];
  readonly other: string;
  readonly otherStart: number;
  readonly otherEnd: number;
};

export function parseClaudeQuestionRows(
  question: QuestionDefinition,
  choices: readonly string[],
): ClaudeQuestionRows | undefined {
  const parsed = choices
    .map((line, index) => ({ index, match: claudeQuestionRow.exec(line) }))
    .filter((item) => item.match);
  if (parsed.length !== question.options.length + 1) return undefined;
  const checked: boolean[] = [];
  let cursor = -1;
  for (const [index, item] of parsed.entries()) {
    const match = item.match!;
    if (!matchesOption(question, index, match)) return undefined;
    const next = parsed[index + 1];
    if (
      next &&
      !descriptionMatches(
        question.options[index]!.description,
        choices.slice(item.index + 1, next.index),
      )
    )
      return undefined;
    checked.push(match[3] === "✔");
    if (match[1] === "❯") cursor = index;
  }
  const last = parsed.at(-1)!;
  const next =
    question.selection === "multiple"
      ? choices.findIndex((line, index) => index > last.index && /^(?:❯| ) {4}Submit$/.test(line))
      : -1;
  if (question.selection === "multiple") {
    if (next < 0 || choices.slice(next + 1).some((line) => line.trim())) return undefined;
    if (choices[next]!.trimStart().startsWith("❯")) cursor = parsed.length;
  }
  if (cursor < 0) return undefined;
  const other = [
    last.match![4]!,
    ...choices.slice(last.index + 1, next < 0 ? undefined : next).map((line) => line.slice(5)),
  ].join("\n");
  return {
    cursor,
    checked,
    other,
    otherStart: last.index,
    otherEnd: next < 0 ? choices.length - 1 : next - 1,
  };
}

function descriptionMatches(description: string | undefined, rows: readonly string[]): boolean {
  return (
    normalizeClaudeQuestionText(rows.join("\n")) === normalizeClaudeQuestionText(description ?? "")
  );
}

function matchesOption(
  question: QuestionDefinition,
  index: number,
  match: RegExpExecArray,
): boolean {
  return (
    Number(match[2]) === index + 1 &&
    (index >= question.options.length || match[4] === question.options[index]!.label) &&
    (question.selection === "multiple") === (match[3] !== undefined)
  );
}
