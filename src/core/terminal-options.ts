/**
 * Parses numbered options from rendered terminal prompt text.
 * Implements PRD §5.1/§5.5: the single option-parsing rule shared by trust-prompt
 * automation and Codex update-prompt skipping, so a CLI format change updates
 * both at once instead of letting them diverge.
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
