/** Parse native Claude questionnaire layouts (PRD §5.10, C-QUESTION-03). */
import type { QuestionFrame } from "../../core/questions/adapter.ts";
import type { QuestionDefinition } from "../../core/questions/types.ts";
import { claudeNamedBorder } from "../composer/border.ts";
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
      readonly hasSubmitTab: boolean;
      /** Zero-based selection-list index: options, Other, then Next or Submit when present. */
      readonly cursor: number;
      readonly checked: readonly boolean[];
      /**
       * Other editor text as drawn. When the cursor ends the value on the editor's last row, the
       * blank cells after it are removed. The placeholder, or a value with the cursor elsewhere,
       * keeps any blank cells a replaced notice left.
       */
      readonly other: string;
    }
  | {
      readonly kind: "review";
      /** Zero-based review selection: Submit answers (0) or Cancel (1). */
      readonly cursor: number;
      /** Non-blank rows after the title and before the actions, less any ready label; folded, LF-joined. */
      readonly summary: string;
    };
const CLAUDE_REVIEW_TITLE = "Review your answers";
const CLAUDE_REVIEW_READY_LABEL = "Ready to submit your answers?";
const fence = /^[─━]{3,}$/;
const header = /^(?:←\s+)?\s*[☐☒] /;
/** A shorter question can draw its footer on a replaced notice's row, which keeps blank cells. */
const questionFooter = /^Enter to select · .+ · Esc to cancel *$/;
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
  const { start, body, first, prompt, hasSubmitTab } = panel;
  const questionIndex = questions.findIndex(
    (question) => normalizeClaudeQuestionText(question.prompt) === prompt,
  );
  const question = questions[questionIndex];
  if (!question) {
    return hasSubmitTab && prompt.startsWith(`${CLAUDE_REVIEW_TITLE} ● `)
      ? parseReview(frame, body, first)
      : undefined;
  }
  const footer = body.findLastIndex((line) => questionFooter.test(line));
  if (footer < 0 || !hasOnlyOptionalNamedBorder(body.slice(footer + 1))) return undefined;
  const end = body.findIndex((line, index) => index > first && fence.test(line));
  if (end < 0) return undefined;
  const questionRows = body.slice(first, end);
  const parsed = parseClaudeQuestionRows(question, questionRows, questions.length > 1);
  if (!parsed) return undefined;
  const otherTop = start + 1 + first + parsed.otherStart;
  const otherBottom = start + 1 + first + parsed.otherEnd;
  const otherCursor =
    parsed.cursor === question.options.length &&
    frame.cursorX >= OTHER_CONTINUATION_INDENT_COLUMNS &&
    frame.cursorRow >= otherTop &&
    frame.cursorRow <= otherBottom;
  if (!(questionCursor(frame) || otherCursor)) return undefined;
  const blankCells = otherCursor ? blankCellsFromCursor(frame, otherBottom) : 0;
  return {
    kind: "question",
    questionIndex,
    hasSubmitTab,
    ...parsed,
    other: parsed.other.slice(0, parsed.other.length - blankCells),
  };
}

/**
 * Blank cells from a cursor that ends the Other editor's last row: Claude's cursor cell, and the
 * indent of a notice Claude replaced on that row. xterm's exact prefix keeps wide glyphs and the
 * answer's own trailing spaces. Zero when the cursor is elsewhere or text follows it.
 */
function blankCellsFromCursor(frame: QuestionFrame, lastOtherRow: number): number {
  const row = frame.lines[lastOtherRow];
  const before = frame.cursorLineBefore;
  if (frame.cursorRow !== lastOtherRow || before === undefined || !row?.startsWith(before))
    return 0;
  const after = row.slice(before.length);
  return /^ *$/.test(after) ? after.length : 0;
}

function parseReview(
  frame: QuestionFrame,
  body: readonly string[],
  first: number,
): ClaudeQuestionScreen | undefined {
  if (!questionCursor(frame)) return undefined;
  const submit = body[first]!;
  const [cancel, ...tail] = body.slice(first + 1).filter((line) => line.trim());
  if (!cancel) return undefined;
  if (!(/^(?:❯| )\s+1\. Submit answers$/.test(submit) && reviewCancelRow.test(cancel)))
    return undefined;
  const submitSelected = submit.startsWith("❯");
  const cancelSelected = cancel.startsWith("❯");
  const hasExactlyOneSelectedAction = submitSelected !== cancelSelected;
  if (!(hasExactlyOneSelectedAction && hasOnlyOptionalNamedBorder(tail))) return undefined;
  const summaryRows = body.slice(0, first).filter((line) => line.trim());
  if (summaryRows[0] !== CLAUDE_REVIEW_TITLE) return undefined;
  if (summaryRows.at(-1) === CLAUDE_REVIEW_READY_LABEL) summaryRows.pop();
  const summary = summaryRows.slice(1).map(normalizeClaudeQuestionText).join("\n");
  return { kind: "review", cursor: submitSelected ? 0 : 1, summary };
}

/** Match live tabs and extract the prompt; callers validate the prompt and complete choice rows. */
export function readClaudeQuestionPanel(
  frame: QuestionFrame,
  questions: readonly QuestionDefinition[],
) {
  if (!claudeQuestionCandidate(frame.text)) return undefined;
  const start = questionPanelStart(frame.lines);
  const hasSubmitTab = parseSubmitTabPresence(frame.lines[start], questions);
  if (hasSubmitTab === undefined) return undefined;
  const body = frame.lines.slice(start + 1);
  const first = body.findIndex((line) => row.test(line));
  if (first < 0) return undefined;
  return {
    start,
    body,
    first,
    hasSubmitTab,
    prompt: normalizeClaudeQuestionText(body.slice(0, first).join("\n")),
  };
}

/** Verify ordered native tabs and report whether submission goes through review. */
function parseSubmitTabPresence(
  title: string | undefined,
  questions: readonly QuestionDefinition[],
): boolean | undefined {
  const first = questions[0];
  if (!first || questions.some((question) => !question.header)) return undefined;
  const tabs = questions.map((question) => `☐ ${question.header}`).join("  ");
  // Claude 2.1.310 pads the highlighted single-question chip with a trailing space.
  const visible = title?.replaceAll("☒", "☐").trimEnd();
  if (questions.length === 1 && visible === ` ${tabs}`) return false;
  if (questions.length > 1 || first.selection === "multiple") {
    if (visible === `←  ${tabs}  ✔ Submit  →`) return true;
  }
  return undefined;
}

/** Below the footer: blank rows, plus at most one named session's border (`──── Name ─`). */
function hasOnlyOptionalNamedBorder(footerTail: readonly string[]): boolean {
  const visibleRows = footerTail.filter((line) => line.trim());
  return (
    visibleRows.length === 0 ||
    (visibleRows.length === 1 && claudeNamedBorder.test(visibleRows[0]!))
  );
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
