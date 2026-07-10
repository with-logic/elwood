/**
 * Parses numbered options from rendered terminal prompt text, and exposes the
 * option/non-option line split that trust-prompt HEADER recognition anchors on.
 * Implements PRD §5.1/§5.5: the single option-parsing rule shared by trust-prompt
 * automation and Codex update-prompt skipping, so a CLI format change updates
 * both at once instead of letting them diverge. `nonOptionText` is the one shared
 * recognizer used by BOTH the responder and the screen-fact blocking rules, so a
 * numbered option's text can never be mistaken for a prompt header.
 */

export type NumberedOption = { readonly number: string; readonly label: string };

/** Extracts `N. label` / `N) label` options from `text`, tolerating `›`/`>` prefixes. */
export function numberedOptions(text: string): readonly NumberedOption[] {
  return text.split("\n").flatMap((line) => {
    const matches = line.matchAll(/(?:^|[\s›>])(\d+)[.)]\s*(.+?)(?=\s*\d+[.)]\s*|$)/g);
    return [...matches].map((match) => ({
      number: match[1] as string,
      label: (match[2] as string).trim(),
    }));
  });
}

/** True when `line` is itself a numbered option (e.g. "1. ...", "› 2) ..."). */
export function isOptionLine(line: string): boolean {
  return /(?:^|[\s›>])\d+[.)]/.test(line);
}

/**
 * The frame's NON-option lines joined into one string. Trust-prompt recognition
 * anchors on this so a wrapped header spanning rows still matches while a phrase
 * living only inside a numbered option label is excluded — a hostile option
 * cannot masquerade as a prompt header (PRD §5.1). Shared by the responder and
 * the screen-fact blocking rules so both recognize prompts identically.
 */
export function nonOptionText(frame: string): string {
  return frame
    .split("\n")
    .filter((line) => !isOptionLine(line))
    .join(" ");
}
