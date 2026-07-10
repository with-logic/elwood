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
 * The frame's HEADER text: every line STRICTLY BEFORE the first numbered option,
 * joined into one string. Real trust prompts render the header (which may wrap
 * across rows, and may be followed by blank/descriptive lines) FIRST and the
 * numbered options LAST, so recognition anchors on the pre-option region. This
 * excludes not just the option lines themselves but their WRAPPED CONTINUATION
 * rows too: a benign option whose label wraps onto a second physical row cannot
 * smuggle a trust phrase into the header, because everything from the first
 * option onward is option region, never header (PRD §5.1 option-only anti-spoof).
 * A frame with no numbered option yet contributes its whole text as header, so a
 * mid-render header still matches before the options paint. Shared by the
 * responder and the screen-fact blocking rules so both recognize identically.
 */
export function nonOptionText(frame: string): string {
  const lines = frame.split("\n");
  const firstOption = lines.findIndex(isOptionLine);
  const header = firstOption === -1 ? lines : lines.slice(0, firstOption);
  return header.join(" ");
}
