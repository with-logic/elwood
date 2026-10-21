/** Recognize captured Codex question layouts without matching transcript prose (PRD §4). */
import type { QuestionFrame } from "../../core/questions/adapter.ts";
import type { QuestionDefinition } from "../../core/questions/types.ts";
import { codexWorkingScreen } from "../screen/working.ts";
import { modalFooter, notesFooter, queuedFooter } from "./chrome.ts";
import { queuedOtherLabel } from "./labels.ts";

/** Cursor-owned native editor with separate question, option, and body-row coordinates. */
export type QuestionView = {
  readonly kind: "queued" | "blocking";
  /** Total questions in this native panel, not the number of options. */
  readonly count: number;
  /** Zero-based question position within `count`. */
  readonly index: number;
  /** Trimmed rows between header and footer, retaining blank rows and row positions. */
  readonly body: readonly string[];
  /** Native rows between header and footer, retaining indentation and blank rows. */
  readonly rawBody: readonly string[];
  /** Zero-based selected option; undefined for a panel without an option caret. */
  readonly selected: number | undefined;
  /** Whether the blocking panel displays its notes-editing footer. */
  readonly notes: boolean;
  readonly cursor: {
    /** Offset from the first body row, not the viewport or selected-option row. */
    readonly row: number;
    /** Native cursor visibility; undefined when the frame has no observation. */
    readonly visible: boolean | undefined;
    /** Whether the native cursor cell is dimmed, as for an empty placeholder. */
    readonly dimmed: boolean | undefined;
    /** Untrimmed native row prefix before the cursor, when available. */
    readonly before: string | undefined;
  };
};
/** Number of collapsed queued questions; undefined without complete native badge/composer chrome. */
export function queuedBadge(frame: QuestionFrame): number | undefined {
  const lines = frame.lines.map((line) => line.trim());
  const start = lines.lastIndexOf("• Queued follow-up inputs");
  if (start < 0) return undefined;
  const match = /^\? (\d+) questions?$/.exec(lines[start + 1] ?? "");
  if (
    !match ||
    lines[start + 2] !== "⇧← to answer" ||
    !lines.slice(start + 3).some((line) => line.startsWith("› "))
  )
    return undefined;
  return Number(match[1]);
}
// async-skip-editor.json parks its hidden cursor on the blank row after the footer.
// Preserve that spacer plus one row of tolerance; neither row enters the parsed body.
const footerCursorAllowanceRows = 2;

/** Recognize a complete native editor whose cursor belongs to this panel. */
export function questionView(frame: QuestionFrame): QuestionView | undefined {
  const lines = frame.lines.map((line) => line.trimEnd());
  const end = lines.findLastIndex((line) => line.trim().length > 0);
  const footer = lines[end]?.trim() ?? "";
  if (frame.cursorRow < 0 || frame.cursorRow > end + footerCursorAllowanceRows) return undefined;
  let start: number;
  let count: number;
  let index: number;
  let kind: QuestionView["kind"];
  if (modalFooter.test(footer) || notesFooter.test(footer)) {
    start = lines.findLastIndex((line) => /^\s*Question \d+\/\d+ \(\d+ unanswered\)$/.test(line));
    const match = /^\s*Question (\d+)\/(\d+) \(\d+ unanswered\)$/.exec(lines[start] ?? "");
    if (!match) return undefined;
    index = Number(match[1]) - 1;
    count = Number(match[2]);
    kind = "blocking";
  } else if (queuedFooter.test(footer)) {
    start = lines.lastIndexOf("• Queued follow-up inputs");
    if (start < 0) return undefined;
    const position = lines
      .slice(start + 1, end)
      .map((line) => line.trim())
      .find((line) => /^\d+ of \d+$/.test(line));
    const match = position?.match(/^(\d+) of (\d+)$/);
    index = match ? Number(match[1]) - 1 : 0;
    count = match ? Number(match[2]) : 1;
    kind = "queued";
  } else return undefined;
  if (!questionCursor(frame, lines, start, kind) || index < 0 || index >= count) return undefined;
  const body = lines.slice(start + 1, end).map((line) => line.trim());
  const caret = body.map((line) => /^› (\d+)\. /.exec(line)).find((match) => match !== null);
  return {
    kind,
    count,
    index,
    body,
    rawBody: frame.lines.slice(start + 1, end),
    selected: caret ? Number(caret[1]) - 1 : undefined,
    notes: notesFooter.test(footer),
    cursor: {
      row: frame.cursorRow - start - 1,
      visible: frame.cursorVisible,
      dimmed: frame.cursorCellDimmed,
      before: frame.cursorLineBefore,
    },
  };
}
/** Native choice lists hide the cursor; a working redraw leaves its position above the panel. */
function questionCursor(
  frame: QuestionFrame,
  lines: readonly string[],
  start: number,
  kind: QuestionView["kind"],
): boolean {
  if (frame.cursorRow >= start) return true;
  const row = lines[frame.cursorRow]!;
  return (
    kind === "queued" &&
    frame.cursorVisible === false &&
    frame.cursorX === row.length &&
    codexWorkingScreen.test(row) &&
    lines.slice(frame.cursorRow + 1, start).every((line) => !line.trim())
  );
}
/** Correlate the prompt and complete ordered native options with a known definition. */
export function matchesQuestion(view: QuestionView, question: QuestionDefinition): boolean {
  const content = view.body.filter((line) => line.length > 0);
  if (
    view.kind === "queued" &&
    view.count > 1 &&
    content.shift() !== `${view.index + 1} of ${view.count}`
  )
    return false;
  if (content[0] !== question.prompt) return false;
  if (question.options.length === 0) return view.selected === undefined;
  const expected = expectedOptions(view.kind, question);
  const afterPrompt = view.body.slice(view.body.indexOf(question.prompt) + 1);
  const start = afterPrompt.findIndex((line) => line.length > 0);
  const block = afterPrompt.slice(start);
  const end = block.findIndex((line) => line.length === 0);
  const rows = (end < 0 ? block : block.slice(0, end)).map((line) =>
    /^(?:› )?(\d+)\. (.*)$/.exec(line),
  );
  const editingOther =
    view.kind === "queued" &&
    view.selected === question.options.length &&
    view.cursor.visible === true &&
    view.cursor.before !== undefined &&
    view.cursor.row >= view.body.indexOf(question.prompt) + 1 + start + question.options.length &&
    view.cursor.row < view.rawBody.length;
  const tooFewOptionRows = rows.length < expected.length;
  const extraRowsOutsideOtherEditor = !editingOther && rows.length > expected.length;
  if (tooFewOptionRows || extraRowsOutsideOtherEditor) return false;
  return expected.every((option, index) => {
    const row = rows[index];
    if (!row || Number(row[1]) !== index + 1) return false;
    if (editingOther && index === question.options.length) return true;
    const displayed = row[2]!;
    if (displayed === option.label) return !option.description;
    return (
      displayed.startsWith(`${option.label}  `) &&
      displayed.slice(option.label.length).trim() === option.description
    );
  });
}

/** Queued panels append a native text alternative; blocking definitions include their own. */
function expectedOptions(
  kind: QuestionView["kind"],
  question: QuestionDefinition,
): QuestionDefinition["options"] {
  switch (kind) {
    case "queued":
      return [
        ...question.options,
        { label: queuedOtherLabel(question) },
      ];
    case "blocking":
      return question.options;
  }
}
