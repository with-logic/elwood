/**
 * Recognizes Claude model/effort switch dialogs and their selected action row.
 * Implements PRD §5.3, C-API-24, and C-ATTN-04.
 */

type SwitchOption = {
  readonly affirmative: boolean;
  readonly selected: boolean;
};

type SwitchDialogRegion = {
  readonly subject: "model" | "effort level";
  readonly text: string;
};

export type ClaudeSwitchConfirmation = {
  readonly affirmativeIndex: number;
  readonly selectedIndex: number;
  readonly isCacheWarning: boolean;
};

const optionPattern = /^\s*([❯›])?\s*(?:\d+[.)]\s*)?(Yes,\s*switch to\b.*|No,\s*go back)\s*$/i;

/**
 * The rows of the dialog's own action block: the LAST run of consecutive action rows.
 * Claude renders `Yes, switch to …` and `No, go back` adjacent, so a staged composer
 * line that happens to read like an action is separated from the quoted pair by the
 * warning's prose, a blank line, or a rule, and forms its own shorter run. Returning
 * only the final run means such a draft yields one option, which is not a Yes/No set
 * and so is not a dialog — the caller then declines to drive it.
 */
function actionBlock(region: readonly string[]): readonly string[] {
  let block: string[] = [];
  let current: string[] = [];
  for (const line of region) {
    if (optionPattern.test(line)) {
      current.push(line);
      continue;
    }
    // A run ends at the first non-action row. Keep the longest complete run seen, so the
    // trailing blank rows the terminal pads the screen with cannot discard the real block.
    if (current.length > block.length) block = current;
    current = [];
  }
  return current.length > block.length ? current : block;
}
const cacheLead = "Your next response will be slower and use more tokens";
const cacheTail = "means the full history gets re-read on your next message.";
const hookLead = "A PreModelSwitch hook asked you to confirm";

/** Returns a dialog only when its title and complete Yes/No action set render. */
export function parseClaudeSwitchConfirmation(text: string): ClaudeSwitchConfirmation | undefined {
  const dialog = switchDialogRegion(text);
  if (dialog === undefined || isClaudeIdleComposer(dialog.text)) return undefined;
  const options = switchOptions(dialog.text);
  const affirmativeIndex = options.findIndex((option) => option.affirmative);
  const declineIndex = options.findIndex((option) => !option.affirmative);
  if (affirmativeIndex < 0 || declineIndex < 0) return undefined;
  return {
    affirmativeIndex,
    selectedIndex: options.findIndex((option) => option.selected),
    isCacheWarning: hasCacheWarning(dialog),
  };
}

/** True for built-in and hook-requested model/effort switch confirmations. */
export function isClaudeSwitchConfirmation(text: string): boolean {
  return parseClaudeSwitchConfirmation(text) !== undefined;
}

/** The idle Claude composer, excluding dialog action rows with a caret. */
export function isClaudeIdleComposer(text: string): boolean {
  return /^\s*[❯›]\s*$/m.test(text);
}

/** An agent reply bullet; the row a quoted dialog hangs directly beneath. */
const replyRow = /^\s*[●•⏺]/;

/** True when the row immediately above the title is an agent reply rather than a separator. */
function quotesTheTitle(lines: readonly string[], titleIndex: number): boolean {
  const above = lines[titleIndex - 1];
  return above !== undefined && replyRow.test(above);
}

function switchDialogRegion(text: string): SwitchDialogRegion | undefined {
  const lines = text.split("\n");
  let latest:
    | { readonly index: number; readonly subject: SwitchDialogRegion["subject"] }
    | undefined;
  for (const [index, line] of lines.entries()) {
    const title = line.trim();
    if (title === "Switch model?") latest = { index, subject: "model" };
    if (title === "Change effort level?") latest = { index, subject: "effort level" };
  }
  if (latest === undefined) return undefined;
  // A live dialog replaces the composer, so the transcript above it always ends in the
  // separator Claude draws (a rule, or the blank line before it). A title sitting DIRECTLY
  // under an agent reply row is prose the reply is quoting, and the "options" below it are
  // that quote plus whatever the user has since staged.
  if (quotesTheTitle(lines, latest.index)) return undefined;
  const region = lines.slice(latest.index);
  const lastOption = region.findLastIndex((line) => optionPattern.test(line));
  // A later dialog can lack a switch title. Its question/options must not inherit
  // the earlier cache warning's authority merely because they share a viewport.
  const footer =
    /^\s*(?:Enter to confirm|Esc to cancel)(?:\s*[·•]\s*(?:Enter to confirm|Esc to cancel))*\s*$/i;
  if (region.slice(lastOption + 1).some((line) => line.trim() !== "" && !footer.test(line))) {
    return undefined;
  }
  return { subject: latest.subject, text: region.join("\n") };
}

function switchOptions(text: string): readonly SwitchOption[] {
  // Only the dialog's own CONTIGUOUS action block counts, so a staged composer row that
  // reads like an action cannot pair up with an option quoted elsewhere in the viewport.
  const options = actionBlock(text.split("\n")).map((line) => {
    const match = optionPattern.exec(line) as RegExpExecArray;
    return { affirmative: /^Yes,/i.test(match[2] as string), selected: match[1] !== undefined };
  });
  return options.slice(-2);
}

function hasCacheWarning(dialog: SwitchDialogRegion): boolean {
  const normalized = dialog.text.replace(/\s+/g, " ");
  return (
    !normalized.includes(hookLead) &&
    normalized.includes(cacheLead) &&
    normalized.includes(`This conversation is cached for the current ${dialog.subject}.`) &&
    normalized.includes(cacheTail)
  );
}
