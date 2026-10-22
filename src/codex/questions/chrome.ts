/** Recognize native Codex question footer chrome independently of input parsing (PRD §4; C-ATTN-02). */
export const queuedPanelHeader = "• Queued follow-up inputs";
export const questionHeader = /^\s*Question (\d+)\/(\d+) \(\d+ unanswered\)$/;

export const modalFooter =
  /^tab to add notes \| enter to submit (?:answer|all) \| ←\/→ to navigate questions \| esc to interrupt$/;
export const notesFooter = /^tab or esc to clear notes \| enter to submit (?:answer|all)$/;
export const queuedFooter =
  /^enter submit\s+⌃\] skip\s+⇧→ (?:main prompt|prev question)(?:\s+⇧← next question)?$/;
/** Modal/notes header-footer pairs and expanded queued editors hold ordinary input;
 * collapsed queued badges have no editor footer and do not block. */
export function blockingQuestionVisible(text: string): boolean {
  const trimmed = text.trimEnd();
  const footer = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim();
  const modal = modalFooter.test(footer) || notesFooter.test(footer);
  const queued = queuedFooter.test(footer);
  if (!(modal || queued)) return false;
  const lines = trimmed.split("\n");
  const modalQuestion = modal && lines.some((line) => questionHeader.test(line.trim()));
  const expandedQueuedEditor = queued && lines.some((line) => line.trim() === queuedPanelHeader);
  return modalQuestion || expandedQueuedEditor;
}
