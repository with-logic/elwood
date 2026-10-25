/** Private native Claude questionnaire grammar (PRD §4). */
import type { QuestionFrame } from "../../core/questions/adapter.ts";
import type { QuestionDefinition } from "../../core/questions/types.ts";
import {
  normalizeClaudeQuestionText,
  OTHER_CONTINUATION_INDENT_COLUMNS,
  parseClaudeQuestionRows,
  claudeQuestionRow as row,
} from "./rows.ts";

export type ClaudeQuestionScreen =
  | {
      readonly kind: "question";
      readonly questionIndex: number;
      /** Zero-based selection-list index: options, Other, then optional Submit. */
      readonly cursor: number;
      readonly checked: readonly boolean[];
      readonly other: string;
    }
  | {
      readonly kind: "review";
      /** Zero-based review selection: Submit answers (0) or Cancel (1). */
      readonly cursor: number;
      readonly summary: string;
    };
const CLAUDE_REVIEW_TITLE = "Review your answers";
const CLAUDE_REVIEW_READY_LABEL = "Ready to submit your answers?";
const fence = /^[─━]{3,}$/;
// A named session (`--name`) labels the prompt box's bottom border, under the footer.
const namedBorder = /^[─━]{3,} \S.* [─━]$/;
const header = /^(?:←\s+)?\s*[☐☒] /;
const questionFooter = /^Enter to select · .+ · Esc to cancel$/;
const reviewCancelRow = /^(?:❯| )\s+2\. Cancel$/;

/** Native chrome may be partial; a candidate alone grants no complete parse or answer authority. */
export function claudeQuestionCandidate(text: string): boolean {
  if (!(text.includes("☐") || text.includes("☒"))) return false;
  const lines = text.split("\n");
  const start = questionPanelStart(lines);
  if (start < 0) return false;
  // Only a composer after completed native actions can retire this panel. Question
  // copy may itself contain carets, fences, and footer text; partial panels stay held.
  const footer = lines.findLastIndex((line) => questionFooter.test(line));
  const closingFence = lines.findLastIndex((line, index) => index < footer && fence.test(line));
  const lastOption = lines.findLastIndex((line, index) => index < closingFence && row.test(line));
  const questionEnd = lastOption > start ? footer : -1;
  const reviewEnd = lines.findLastIndex((line) => reviewCancelRow.test(line));
  const end = Math.max(questionEnd, reviewEnd);
  return (
    end <= start || !lines.slice(end + 1).some((line) => /^❯(?!\s+\d+\.|\s+Submit\s*$)/.test(line))
  );
}
/** Return a matching question/review; partial, foreign, or mismatched frames return undefined. */
export function parseClaudeQuestionScreen(
  frame: QuestionFrame,
  questions: readonly QuestionDefinition[],
): ClaudeQuestionScreen | undefined {
  const panel = readClaudeQuestionPanel(frame, questions);
  if (!panel) return undefined;
  const { start, body, first, prompt } = panel;
  const reviewReadyIndex = body.lastIndexOf(CLAUDE_REVIEW_READY_LABEL);
  if (prompt.startsWith(`${CLAUDE_REVIEW_TITLE} `) && reviewReadyIndex >= 0) {
    if (!questionCursor(frame)) return undefined;
    const questionRows = body.slice(first).filter((line) => line.trim());
    if (
      questionRows.length !== 2 ||
      !/^(?:❯| )\s+1\. Submit answers$/.test(questionRows[0]!) ||
      !reviewCancelRow.test(questionRows[1]!)
    )
      return undefined;
    const summary = normalizeClaudeQuestionText(body.slice(0, reviewReadyIndex).join(" "))
      .slice(CLAUDE_REVIEW_TITLE.length)
      .trim();
    return { kind: "review", cursor: questionRows[0]!.startsWith("❯") ? 0 : 1, summary };
  }
  const questionIndex = questions.findIndex(
    (question) => normalizeClaudeQuestionText(question.prompt) === prompt,
  );
  const question = questions[questionIndex];
  if (!question) return undefined;
  const footer = body.findLastIndex((line) => questionFooter.test(line));
  const [after, ...extra] = body.slice(footer + 1).filter((line) => line.trim());
  if (footer < 0 || extra.length > 0 || (after !== undefined && !namedBorder.test(after)))
    return undefined;
  const end = body.findIndex((line, index) => index > first && fence.test(line));
  if (end < 0) return undefined;
  const questionRows = body.slice(first, end);
  const parsed = parseClaudeQuestionRows(question, questionRows);
  if (!parsed) return undefined;
  const otherTop = start + 1 + first + parsed.otherStart;
  const otherBottom = start + 1 + first + parsed.otherEnd;
  const otherCursor =
    parsed.cursor === question.options.length &&
    frame.cursorX >= OTHER_CONTINUATION_INDENT_COLUMNS &&
    frame.cursorRow >= otherTop &&
    frame.cursorRow <= otherBottom;
  return questionCursor(frame) || otherCursor
    ? { kind: "question", questionIndex, ...parsed }
    : undefined;
}

/** Match live tabs and extract the prompt; callers validate the prompt and complete choice rows. */
export function readClaudeQuestionPanel(
  frame: QuestionFrame,
  questions: readonly QuestionDefinition[],
) {
  if (!(claudeQuestionCandidate(frame.text) && matchesClaudeQuestionTabs(frame, questions)))
    return undefined;
  const start = questionPanelStart(frame.lines);
  const body = frame.lines.slice(start + 1);
  const first = body.findIndex((line) => row.test(line));
  if (first < 0) return undefined;
  return {
    start,
    body,
    first,
    prompt: normalizeClaudeQuestionText(body.slice(0, first).join("\n")),
  };
}

export function matchesClaudeQuestionTabs(
  frame: QuestionFrame,
  questions: readonly QuestionDefinition[],
): boolean {
  if (questions.length === 0 || questions.some((question) => !question.header)) return false;
  const title = frame.lines[questionPanelStart(frame.lines)];
  const tabs = questions.map((question) => `☐ ${question.header}`).join("  ");
  const expected = questions.length === 1 ? ` ${tabs}` : `←  ${tabs}  ✔ Submit  →`;
  // Claude 2.1.310 pads the highlighted single-question chip with a trailing space.
  return title?.replaceAll("☒", "☐").trimEnd() === expected;
}

/** Header-like model copy without a native opening fence cannot replace the live panel. */
function questionPanelStart(lines: readonly string[]): number {
  return lines.findLastIndex(
    (line, index) => header.test(line) && index > 0 && fence.test(lines[index - 1]!),
  );
}

/** Captured native selection dialogs can park their cursor at the bottom-left viewport cell. */
function questionCursor(frame: QuestionFrame): boolean {
  return (
    /^❯/.test(frame.lines[frame.cursorRow] ?? "") ||
    (frame.cursorX === 0 && frame.cursorRow === frame.rows - 1)
  );
}
