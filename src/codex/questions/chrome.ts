/** Recognize native Codex question chrome and composer boundaries independently of input parsing (PRD §4; C-ATTN-02). */
export const composerInputPrefix = /^[›»] /;
export const queuedPanelHeader = "• Queued follow-up inputs";
export const questionHeader = /^\s*Question (\d+)\/(\d+) \(\d+ unanswered\)$/;

const modalFooterWithNavigation =
  /^tab to add notes \| enter to submit (?:answer|all) \| ←\/→ to navigate questions \| esc to interrupt$/;
const modalFooterWithoutNavigation =
  /^tab to add notes \| enter to submit answer \| esc to interrupt$/;
const notesFooter = /^tab or esc to clear notes \| enter to submit (?:answer|all)$/;
export type ModalQuestionFooter = "withNavigation" | "withoutNavigation" | "notes";

/** Classify footer text for the input hold. The editor separately validates the header. */
export function modalQuestionFooter(footer: string): ModalQuestionFooter | undefined {
  if (modalFooterWithNavigation.test(footer)) return "withNavigation";
  if (modalFooterWithoutNavigation.test(footer)) return "withoutNavigation";
  if (notesFooter.test(footer)) return "notes";
  return undefined;
}

const queuedFooter =
  /^enter submit\s+⌃\] skip\s+⇧→ (?:main prompt|prev question)(?:\s+⇧← next question)?$/;
const queuedHint = String.raw`(?:enter submit|⌃\] skip|⇧→ (?:main prompt|prev question)|⇧← next question)`;
// A row of the queued footer's hints, three spaces apart.
const queuedHintRow = new RegExp(`^${queuedHint}(?: {3}${queuedHint})*$`);
// The footer has four hints, so it never takes more than four rows.
const maxQueuedFooterRows = 4;

/**
 * The row where the queued panel's footer starts, when the rows up to `end` are that footer.
 * Codex draws its hints on one row and wraps them onto more in a pane too narrow for them:
 * 0.172 moves `⇧← next question` to its own row at 60 and 50 columns, and at 40 columns
 * draws `enter submit   ⌃] skip` above `⇧→ main prompt   ⇧← next question`.
 */
export function queuedFooterStart(lines: readonly string[], end: number): number | undefined {
  const rows = lines
    .slice(Math.max(0, end + 1 - maxQueuedFooterRows), end + 1)
    .map((row) => row.trim());
  if (queuedFooter.test(rows.at(-1) ?? "")) return end;
  const hintRows = rows.length - 1 - rows.findLastIndex((row) => !queuedHintRow.test(row));
  const hints = rows.slice(rows.length - hintRows).join("   ");
  return hintRows > 1 && queuedFooter.test(hints) ? end + 1 - hintRows : undefined;
}

/** Modal/notes header-footer pairs and expanded queued editors hold ordinary input;
 * collapsed queued badges have no editor footer and do not block. */
export function blockingQuestionVisible(text: string): boolean {
  const trimmed = text.trimEnd();
  const footer = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim();
  const lines = trimmed.split("\n");
  const modal = modalQuestionFooter(footer) !== undefined;
  const queued = queuedFooterStart(lines, lines.length - 1) !== undefined;
  if (!(modal || queued)) return false;
  const modalQuestion = modal && lines.some((line) => questionHeader.test(line.trim()));
  const expandedQueuedEditor = queued && lines.some((line) => line.trim() === queuedPanelHeader);
  return modalQuestion || expandedQueuedEditor;
}
