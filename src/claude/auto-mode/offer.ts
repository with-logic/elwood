/**
 * Recognizes Claude's auto-mode setup offer, its first menu and the setup step that menu
 * opens, as a blocking dialog, and the first menu alone as the one Elwood declines.
 * Implements PRD §5.3, §5.1, C-ATTN-09 and C-CLAUDE-27.
 */

/** The offer's screen rule and attention label; `elwood run` matches it too (C-CLI-05). */
export const claudeAutoModeOfferRuleId = "claude-auto-mode-offer";

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

/** The last frame read, so the screen rule and the decliner split each frame only once. */
let lastFrame: { readonly text: string; readonly rows: readonly string[] | undefined } | undefined;

/** The offer's rows between its title and its key hint, or undefined when it is not shown. */
function offerRows(text: string): readonly string[] | undefined {
  // Nearly every frame lacks the title: one substring search, with no split or allocation.
  if (!text.includes(offerTitle)) return undefined;
  if (lastFrame?.text !== text) lastFrame = { text, rows: readOfferRows(text) };
  return lastFrame.rows;
}

function readOfferRows(text: string): readonly string[] | undefined {
  const lines = text.split("\n");
  const title = lines.findLastIndex((line) => line.trim() === offerTitle);
  if (title < 1 || !ruleRow.test(lines[title - 1] as string)) return undefined;
  const rows: string[] = [];
  for (const line of lines.slice(title + 1)) {
    if (cancelHint.test(line.trim())) return rows;
    if (ruleRow.test(line)) return undefined;
    rows.push(line.trim());
  }
  return undefined;
}

/**
 * True while the offer's first menu or the setup step it opens is on screen. Claude can
 * paint the menu above a composer that stays visible, so a caller's paste and Enter would
 * otherwise go to the offer and answer it.
 */
export function isClaudeAutoModeOffer(text: string): boolean {
  return offerRows(text) !== undefined;
}

/** The first menu's deferring and declining options; the setup step has neither. */
const notNow = /^(?:❯\s*)?2\. Not now$/;
const dontShowAgain = /^(?:❯\s*)?3\. Don't show again$/;

/** True only for the offer's first menu, the one Elwood declines (C-CLAUDE-27). */
export function isClaudeAutoModeOfferMenu(text: string): boolean {
  const rows = offerRows(text) ?? [];
  return rows.some((row) => notNow.test(row)) && rows.some((row) => dontShowAgain.test(row));
}
