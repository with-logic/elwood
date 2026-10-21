/** Verify native answer drafts before submission, preserving human text (PRD §7A.5). */
import type { QuestionDefinition } from "../../core/questions/types.ts";
import type { QuestionView } from "./frame.ts";

export function draftMatches(
  view: QuestionView,
  question: QuestionDefinition,
  expected: string,
): boolean {
  const lines = view.rawBody;
  let start: number;
  let prefix: string;
  let placeholder: string;
  if (view.kind === "blocking") {
    if (!view.notes) return false;
    start = lines.findLastIndex((line) => /^\s*› /.test(line));
    prefix = /^\s*› /.exec(lines[start] ?? "")?.[0] ?? "";
    placeholder = "Add notes";
  } else if (question.options.length > 0) {
    if (view.selected !== question.options.length) return false;
    start = lines.findIndex((line) => /^\s*› \d+\. /.test(line));
    prefix = /^\s*› \d+\. /.exec(lines[start] ?? "")?.[0] ?? "";
    placeholder = question.options.some((option) => option.label.toLowerCase() === "other")
      ? "Other (write an answer)"
      : "Other";
  } else {
    const prompt = lines.findIndex((line) => line.trim() === question.prompt);
    start = lines.findIndex((line, index) => index > prompt && line.trim().length > 0);
    prefix = "  ";
    placeholder = "Type your answer";
  }
  if (start < 0 || !prefix) return false;
  const remaining = lines.slice(start);
  while (remaining.at(-1)?.trim() === "") remaining.pop();
  const text = remaining.map((line) => line.slice(prefix.length)).join("\n");
  return text === expected || (expected === "" && text === placeholder);
}
