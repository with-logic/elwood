/** Verify unambiguous visible drafts; wrapped/clipped text needs owned-paste proof (PRD §4). */
import type { QuestionDefinition } from "../../core/questions/types.ts";
import type { QuestionView } from "./frame.ts";

export function draftMatches(
  view: QuestionView,
  question: QuestionDefinition,
  expected: string,
): boolean {
  const position = draftPosition(view, question);
  if (!position || expected.includes("\n")) return false;
  const { start, prefix, placeholder } = position;
  const lines = view.rawBody;
  const remaining = lines.slice(start);
  while (remaining.at(-1)?.trim() === "") remaining.pop();
  if (remaining.length !== 1) return false;
  const text = remaining[0]!.slice(prefix.length);
  const cursor = view.cursor;
  if (text.trimEnd() === placeholder) {
    if (cursor.visible !== true || cursor.row !== start) return false;
    return expected === ""
      ? cursor.dimmed === true && cursor.before === prefix
      : expected === placeholder && cursor.dimmed === false && cursor.before === prefix + expected;
  }
  if (
    cursor.before !== undefined &&
    (cursor.visible !== true || cursor.row !== start || cursor.before !== prefix + expected)
  )
    return false;
  return text === expected;
}

function draftPosition(view: QuestionView, question: QuestionDefinition) {
  const lines = view.rawBody;
  let start: number;
  let prefix: string;
  let placeholder: string;
  if (view.kind === "blocking") {
    if (!view.notes) return undefined;
    const firstOption = lines.findIndex((line) => /^\s*(?:› )?1\. /.test(line));
    if (firstOption < 0) return undefined;
    const afterOptions = lines.findIndex((line, index) => index > firstOption && !line.trim());
    start = lines.findIndex((line, index) => index > afterOptions && /^ {2}› /.test(line));
    prefix = "  › ";
    placeholder = "Add notes";
  } else if (question.options.length > 0) {
    if (view.selected !== question.options.length) return undefined;
    start = lines.findIndex((line) => /^\s*› \d+\. /.test(line));
    if (start < 0) return undefined;
    prefix = /^\s*› \d+\. /.exec(lines[start]!)![0];
    placeholder = question.options.some((option) => option.label.toLowerCase() === "other")
      ? "Other (write an answer)"
      : "Other";
  } else {
    const prompt = lines.findIndex((line) => line.trim() === question.prompt);
    if (prompt < 0) return undefined;
    start = lines.findIndex((line, index) => index > prompt && line.trim().length > 0);
    prefix = "  ";
    placeholder = "Type your answer";
  }
  return start < 0 ? undefined : { start, prefix, placeholder };
}
