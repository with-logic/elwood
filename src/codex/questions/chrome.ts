/** Recognize native Codex question chrome and composer boundaries independently of input parsing (PRD §4; C-ATTN-02). */
export const composerInputPrefix = /^[›»] /;
export const queuedPanelHeader = "• Queued follow-up inputs";
export const questionHeader = /^\s*Question (\d+)\/(\d+) \(\d+ unanswered\)$/;

const modalFooter =
  /^tab to add notes \| enter to submit (?:answer|all) \| ←\/→ to navigate questions \| esc to interrupt$/;
const standaloneModalFooter = /^tab to add notes \| enter to submit answer \| esc to interrupt$/;
const notesFooter = /^tab or esc to clear notes \| enter to submit (?:answer|all)$/;
/** Identify the native footer once for blocking detection and editor parsing. */
export function modalQuestionFooter(footer: string): "group" | "standalone" | "notes" | undefined {
  if (modalFooter.test(footer)) return "group";
  if (standaloneModalFooter.test(footer)) return "standalone";
  if (notesFooter.test(footer)) return "notes";
  return undefined;
}

export const queuedFooter =
  /^enter submit\s+⌃\] skip\s+⇧→ (?:main prompt|prev question)(?:\s+⇧← next question)?$/;
/** Modal/notes header-footer pairs and expanded queued editors hold ordinary input;
 * collapsed queued badges have no editor footer and do not block. */
export function blockingQuestionVisible(text: string): boolean {
  const trimmed = text.trimEnd();
  const footer = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim();
  const modal = modalQuestionFooter(footer) !== undefined;
  const queued = queuedFooter.test(footer);
  if (!(modal || queued)) return false;
  const lines = trimmed.split("\n");
  const modalQuestion = modal && lines.some((line) => questionHeader.test(line.trim()));
  const expandedQueuedEditor = queued && lines.some((line) => line.trim() === queuedPanelHeader);
  return modalQuestion || expandedQueuedEditor;
}
