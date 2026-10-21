/** Recognize native Codex question footer chrome independently of input parsing (PRD §4). */
export const modalFooter =
  /^tab to add notes \| enter to submit (?:answer|all) \| ←\/→ to navigate questions \| esc to interrupt$/;
export const notesFooter = /^tab or esc to clear notes \| enter to submit (?:answer|all)$/;
export const queuedFooter =
  /^enter submit\s+⌃\] skip\s+⇧→ (?:main prompt|prev question)(?:\s+⇧← next question)?$/;
export function blockingQuestionVisible(text: string): boolean {
  const lines = text
    .trimEnd()
    .split("\n")
    .map((line) => line.trim());
  return (
    lines.some((line) => /^Question \d+\/\d+ \(\d+ unanswered\)$/.test(line)) &&
    (modalFooter.test(lines.at(-1)!) || notesFooter.test(lines.at(-1)!))
  );
}
