/** Private native Claude questionnaire grammar (PRD §4). */
import type { QuestionFrame } from "../../core/questions/adapter.ts";
import type { QuestionDefinition } from "../../core/questions/types.ts";
import {
  normalizeClaudeQuestionText,
  parseClaudeQuestionRows,
  claudeQuestionRow as row,
} from "./rows.ts";

export type ClaudeQuestionScreen =
  | {
      readonly kind: "question";
      readonly questionIndex: number;
      readonly cursor: number;
      readonly checked: readonly boolean[];
      readonly other: string;
    }
  | { readonly kind: "review"; readonly cursor: number };
const fence = /^[─━]{3,}$/;
const header = /^(?:←\s+)?\s*[☐☒] /;

export function claudeQuestionCandidate(text: string): boolean {
  const lines = text.split("\n");
  const start = lines.findLastIndex((line) => header.test(line));
  if (start < 1 || !fence.test(lines[start - 1]!)) return false;
  return !lines.slice(start + 1).some((line) => /^❯(?!\s+\d+\.|\s+Submit\s*$)/.test(line));
}
export function parseClaudeQuestionScreen(
  frame: QuestionFrame,
  questions: readonly QuestionDefinition[],
): ClaudeQuestionScreen | undefined {
  if (!claudeQuestionCandidate(frame.text)) return undefined;
  const lines = frame.lines;
  const start = lines.findLastIndex((line) => header.test(line));
  if (!matchesClaudeQuestionTabs(frame, questions)) return undefined;
  const body = lines.slice(start + 1);
  const first = body.findIndex((line) => row.test(line));
  if (first < 0) return undefined;
  const prompt = normalizeClaudeQuestionText(body.slice(0, first).join("\n"));
  if (
    prompt.startsWith("Review your answers ") &&
    body.some((line) => line === "Ready to submit your answers?")
  ) {
    if (!questionCursor(frame)) return undefined;
    const choices = body.slice(first).filter((line) => line.trim());
    if (
      choices.length !== 2 ||
      !/^(?:❯| )\s+1\. Submit answers$/.test(choices[0]!) ||
      !/^(?:❯| )\s+2\. Cancel$/.test(choices[1]!)
    )
      return undefined;
    return { kind: "review", cursor: choices[0]!.startsWith("❯") ? 0 : 1 };
  }
  const questionIndex = questions.findIndex(
    (question) => normalizeClaudeQuestionText(question.prompt) === prompt,
  );
  const question = questions[questionIndex];
  if (!question) return undefined;
  const footer = body.findIndex((line) => /^Enter to select · .+ · Esc to cancel$/.test(line));
  if (footer < 0 || body.slice(footer + 1).some((line) => line.trim())) return undefined;
  const end = body.findIndex((line, index) => index > first && fence.test(line));
  if (end < 0) return undefined;
  const choices = body.slice(first, end);
  const parsed = parseClaudeQuestionRows(question, choices);
  if (!parsed) return undefined;
  const otherTop = start + 1 + first + parsed.otherStart;
  const otherBottom = start + 1 + first + parsed.otherEnd;
  const otherCursor =
    parsed.cursor === question.options.length &&
    frame.cursorX >= 5 &&
    frame.cursorRow >= otherTop &&
    frame.cursorRow <= otherBottom;
  return questionCursor(frame) || otherCursor
    ? { kind: "question", questionIndex, ...parsed }
    : undefined;
}

export function matchesClaudeQuestionTabs(
  frame: QuestionFrame,
  questions: readonly QuestionDefinition[],
): boolean {
  if (questions.length === 0 || questions.some((question) => !question.header)) return false;
  const title = frame.lines.findLast((line) => header.test(line));
  const tabs = questions.map((question) => `☐ ${question.header}`).join("  ");
  const expected = questions.length === 1 ? ` ${tabs}` : `←  ${tabs}  ✔ Submit  →`;
  return title?.replaceAll("☒", "☐") === expected;
}

/** Captured native selection dialogs can park their cursor at the bottom-left viewport cell. */
function questionCursor(frame: QuestionFrame): boolean {
  return (
    /^❯/.test(frame.lines[frame.cursorRow] ?? "") ||
    (frame.cursorX === 0 && frame.cursorRow === frame.rows - 1)
  );
}
