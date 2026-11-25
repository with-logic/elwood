/**
 * Recognizes Claude's auto-mode setup offer, its first menu and the setup step that menu
 * opens, as a blocking dialog. Implements PRD §5.3 and C-ATTN-09.
 */

/**
 * The offer's title row (Claude 2.1.332). Its first menu and the setup step it opens both
 * repeat it. Later steps, such as the scan and its review, use other titles.
 */
const offerTitle = "Teach auto mode about your environment?";
/**
 * A full-width rule at column 0. Claude paints one directly above the title (`─` above the
 * menu, `▔` above the setup step), and the composer's fence is one too, so a rule after the
 * title ends the dialog. Transcript rows are indented or start with a reply or prompt
 * marker, so a reply that quotes the title never sits under one.
 */
const ruleRow = /^[─━▔]{3,}/;
/** The dialog's own key-hint row: both the menu's and the setup step's end this way. */
const cancelHint = /Esc to cancel$/i;

/**
 * True while the offer's first menu or the setup step it opens is on screen. Claude can
 * paint the menu above a composer that stays visible, so a caller's paste and Enter would
 * otherwise go to the offer and answer it.
 */
export function isClaudeAutoModeOffer(text: string): boolean {
  const lines = text.split("\n");
  const title = lines.findLastIndex((line) => line.trim() === offerTitle);
  if (title < 1 || !ruleRow.test(lines[title - 1] as string)) return false;
  for (const line of lines.slice(title + 1)) {
    if (cancelHint.test(line.trim())) return true;
    if (ruleRow.test(line)) return false;
  }
  return false;
}
