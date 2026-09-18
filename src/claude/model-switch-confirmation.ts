/**
 * Recognizes Claude model/effort switch dialogs and their selected action row.
 * Implements PRD §5.3, C-API-24, and C-ATTN-04.
 */

import { bottomDialogRow } from "../core/models/rows.ts";

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

/**
 * A switch title opening the bottom-most region, even before its copy and options
 * paint. Claude 2.1.274 renders one such frame between the picker and the warning.
 * It cannot yet be told from a hook confirmation, so it is held on and never answered.
 */
export function isClaudeSwitchShell(text: string): boolean {
  return (
    bottomDialogRow(text, /^\s*(?:Switch model|Change effort level)\?\s*$/, optionPattern) >= 0
  );
}

/** The idle Claude composer, excluding dialog action rows with a caret. */
export function isClaudeIdleComposer(text: string): boolean {
  return /^\s*[❯›]\s*$/m.test(text);
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
  const options = text.split("\n").flatMap((line) => {
    const match = optionPattern.exec(line);
    if (match === null) return [];
    return [{ affirmative: /^Yes,/i.test(match[2] as string), selected: match[1] !== undefined }];
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
