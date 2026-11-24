/** Detect non-whitespace prompt text without modifying it (PRD §5.4). */
const nonWhitespace = /[^\p{White_Space}]/u;

export function hasPromptText(text: string): boolean {
  return nonWhitespace.test(text);
}
