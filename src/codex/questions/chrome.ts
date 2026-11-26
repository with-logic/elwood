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
export type ModalQuestionFooter = "withNavigation" | "withoutNavigation" | "notes";
/** A queued panel's footer, or the layout of a modal editor's. */
export type QuestionFooter = "queued" | ModalQuestionFooter;
// No question footer has more than four hints, and Codex wraps a footer only between hints.
const maxFooterRows = 4;

/** Classify footer rows, joined with the separator Codex draws between their hints. */
function classifyFooter(rows: readonly string[]): QuestionFooter | undefined {
  if (queuedFooter.test(rows.join("   "))) return "queued";
  const modal = rows.join(" | ");
  if (modalFooterWithNavigation.test(modal)) return "withNavigation";
  if (modalFooterWithoutNavigation.test(modal)) return "withoutNavigation";
  if (notesFooter.test(modal)) return "notes";
  return undefined;
}

/**
 * The question footer whose last row is `lastRow`: its kind and first row. Codex draws a footer
 * on one row and wraps it onto more in a pane too narrow for it. At 60 and 50 columns 0.172
 * moves `⇧← next question` to a row of its own and splits the modal footer after its second
 * hint; at 40 columns it gives each modal hint a row.
 */
export function questionFooter(
  lines: readonly string[],
  lastRow: number,
): { readonly kind: QuestionFooter; readonly start: number } | undefined {
  for (let start = lastRow; start >= 0 && lastRow - start < maxFooterRows; start--) {
    const kind = classifyFooter(lines.slice(start, lastRow + 1).map((row) => row.trim()));
    if (kind) return { kind, start };
  }
  return undefined;
}

/** Modal/notes header-footer pairs and expanded queued editors hold ordinary input;
 * collapsed queued badges have no editor footer and do not block. */
export function blockingQuestionVisible(text: string): boolean {
  const lines = text.trimEnd().split("\n");
  const footer = questionFooter(lines, lines.length - 1)?.kind;
  if (footer === undefined) return false;
  if (footer === "queued") return lines.some((line) => line.trim() === queuedPanelHeader);
  return lines.some((line) => questionHeader.test(line.trim()));
}
