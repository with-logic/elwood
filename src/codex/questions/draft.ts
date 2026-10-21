/** Verify unambiguous visible drafts; wrapped/clipped text needs owned-paste proof (PRD §4). */
import type { QuestionDefinition } from "../../core/questions/types.ts";
import type { QuestionView } from "./frame.ts";
import { queuedOtherLabel } from "./labels.ts";

/**
 * True only when a single visible editor row exactly matches `expected`; supplied
 * cursor-prefix evidence must agree. Placeholder text requires a visible cursor on
 * the editor row: dimmed at its prefix for empty input, or undimmed after the full
 * literal answer. Multiline, wrapped, clipped, and ambiguous drafts return false;
 * complete logical answers require the separate owned-paste/native-acceptance path.
 */
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
    const cursorOwnsEditorRow = cursor.visible === true && cursor.row === start;
    if (!cursorOwnsEditorRow) return false;
    const expectsEmptyPlaceholder = expected === "";
    const hasEmptyPlaceholderCursor = cursor.dimmed === true && cursor.before === prefix;
    const expectsLiteralPlaceholder = expected === placeholder;
    const hasLiteralAnswerCursor = cursor.dimmed === false && cursor.before === prefix + expected;
    return expectsEmptyPlaceholder
      ? hasEmptyPlaceholderCursor
      : expectsLiteralPlaceholder && hasLiteralAnswerCursor;
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
    placeholder = queuedOtherLabel(question);
  } else {
    const promptIndex = lines.findIndex((line) => line.trim() === question.prompt);
    if (promptIndex < 0) return undefined;
    start = lines.findIndex((line, index) => index > promptIndex && line.trim().length > 0);
    prefix = "  ";
    placeholder = "Type your answer";
  }
  return start < 0 ? undefined : { start, prefix, placeholder };
}
