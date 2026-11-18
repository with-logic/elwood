/** Native model-dialog closing hints shared by complete/prefix readers (C-API-24/55). */
export const claudeModelFooter = /\besc to cancel\b/i;
export const codexModelFooter = /\besc (?:to go )?back\b/i;

const hintClause =
  /^(?:esc (?:to cancel|(?:to go )?back)|enter (?:(?:to )?(?:confirm|save|select|expand|collapse)|to set as default|default)|s (?:to use this session only|session)|←\/→ to adjust|press enter to confirm or esc to go back)$/i;

/** A phrase inside prose cannot grant the closing hint's write authority. */
export function isModelFooter(line: string, footer: RegExp): boolean {
  return footer.test(line) && line.split(/[·•]/).every((clause) => hintClause.test(clause.trim()));
}
