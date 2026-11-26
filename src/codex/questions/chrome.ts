/** Recognize native Codex question chrome and composer boundaries independently of input parsing (PRD §4; C-ATTN-02). */
export const composerInputPrefix = /^[›»] /;
export const queuedPanelHeader = "• Queued follow-up inputs";
export const questionHeader = /^\s*Question (\d+)\/(\d+) \(\d+ unanswered\)$/;

const modalFooterWithNavigation =
  /^tab to add notes \| enter to submit (?:answer|all) \| ←\/→ to navigate questions \| esc to interrupt$/;
const modalFooterWithoutNavigation =
  /^tab to add notes \| enter to submit answer \| esc to interrupt$/;
const notesFooter = /^tab or esc to clear notes \| enter to submit (?:answer|all)$/;
const queuedFooter =
  /^enter submit {3}⌃\] skip {3}⇧→ (?:main prompt|prev question)(?: {3}⇧← next question)?$/;
export type ModalQuestionFooterKind = "withNavigation" | "withoutNavigation" | "notes";
/** A queued panel's footer, or the layout of a modal editor's. */
export type QuestionFooterKind = "queued" | ModalQuestionFooterKind;
/** What each modal footer says about its editor. */
export const modalFooterLayouts = {
  withNavigation: { requireSingleQuestion: false, notes: false },
  // Codex leaves out the navigation hint only for a single question.
  withoutNavigation: { requireSingleQuestion: true, notes: false },
  notes: { requireSingleQuestion: false, notes: true },
} as const satisfies Record<
  ModalQuestionFooterKind,
  { readonly requireSingleQuestion: boolean; readonly notes: boolean }
>;
// No question footer has more than four hints, and Codex wraps a footer only between hints.
const maxFooterRows = 4;
// Every captured footer starts below a blank row; the row above a footer is part of the match.
const footerScanRows = maxFooterRows + 1;

/** Classify footer rows, joined with the separator Codex draws between their hints. */
function classifyFooter(rows: readonly string[]): QuestionFooterKind | undefined {
  if (queuedFooter.test(rows.join("   "))) return "queued";
  const modal = rows.join(" | ");
  if (modalFooterWithNavigation.test(modal)) return "withNavigation";
  if (modalFooterWithoutNavigation.test(modal)) return "withoutNavigation";
  if (notesFooter.test(modal)) return "notes";
  return undefined;
}

/**
 * The question footer whose last row is `lastRow`: its kind and first row. Codex draws a footer
 * on one row, and in a pane too narrow for it wraps the footer between its hints. 0.172 moves
 * `⇧← next question` to a row of its own at 60 and 50 columns, and fits as many modal hints on
 * a row as it can: three at 80 columns, two at 60 and 50, one at 40.
 */
export function questionFooter(
  lines: readonly string[],
  lastRow: number,
): { readonly kind: QuestionFooterKind; readonly firstRow: number } | undefined {
  for (let firstRow = lastRow; firstRow >= 0 && lastRow - firstRow < maxFooterRows; firstRow--) {
    const kind = classifyFooter(lines.slice(firstRow, lastRow + 1).map((row) => row.trim()));
    // An unknown row above the hints would be a layout Elwood has not seen, not part of the body.
    if (kind && (firstRow === 0 || lines[firstRow - 1]!.trim() === "")) return { kind, firstRow };
  }
  return undefined;
}

/** The last `count` rows of `text`, read from its end so a render does not split the screen. */
export function lastRows(text: string, count: number): readonly string[] {
  const rows: string[] = [];
  let end = text.length;
  for (;;) {
    const start = end === 0 ? -1 : text.lastIndexOf("\n", end - 1);
    rows.unshift(text.slice(start + 1, end));
    if (start < 0 || rows.length === count) return rows;
    end = start;
  }
}

/** Modal/notes header-footer pairs and expanded queued editors hold ordinary input;
 * collapsed queued badges have no editor footer and do not block. */
export function blockingQuestionVisible(text: string): boolean {
  const screen = text.trimEnd();
  const tail = lastRows(screen, footerScanRows);
  const footerKind = questionFooter(tail, tail.length - 1)?.kind;
  if (footerKind === undefined) return false;
  const lines = screen.split("\n");
  switch (footerKind) {
    case "queued":
      return lines.some((line) => line.trim() === queuedPanelHeader);
    case "withNavigation":
    case "withoutNavigation":
    case "notes":
      return lines.some((line) => questionHeader.test(line.trim()));
  }
}
