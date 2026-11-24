/** Keep a synthetic empty hook prompt out of turn acceptance (PRD §5.8). */
// Normalization marks the same event object that freezing and hook delivery preserve.
const normalizedMissingPrompts = new WeakSet<object>();

export function markSynthesizedPrompt(event: object): void {
  normalizedMissingPrompts.add(event);
}

export function hasSynthesizedPrompt(event: object): boolean {
  return normalizedMissingPrompts.has(event);
}
