/** Observe native empty Claude input without requiring an idle turn (PRD §5.3, C-API-56). */
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { loginRenewalNotice } from "../login/notice.ts";
import { claudeNamedBorder } from "./border.ts";
import { readClaudeInputCursor } from "./cursor.ts";
import { claudeComposerFooter, claudeFooterOverflow, claudeWorkingFooter } from "./footer.ts";

/** Native empty-composer row shape. Callers verify native activity and dialogs. */
export const claudeComposerText = String.raw`❯(?:[ \t ]*|[ \t ]+Try "[^"\n]+")`;
export const claudeComposerRow = new RegExp(String.raw`^\s*${claudeComposerText}\s*$`, "m");
/** Also Claude 2.1.332's empty composer while messages it queued during a turn wait to run. */
const claudeWorkingComposerRow = new RegExp(
  String.raw`^\s*(?:${claudeComposerText}|❯\s+Press up to edit queued messages)\s*$`,
);

const rule = /^[─━]{3,}\s*$/;
export function claudeEmptyInputFrame(terminal: ElwoodTerminal) {
  const frame = readClaudeInputCursor(terminal)?.frame;
  if (!frame) return undefined;
  return claudeEmptyInputRows(frame.lines, frame.cursorY) ? frame : undefined;
}

/**
 * Claude's empty composer while a turn runs, over its working footer, and also while it holds
 * the queued-messages placeholder. Only prompt association reads it (PRD §5.4, C-API-71).
 */
export function claudeWorkingEmptyInputFrame(terminal: ElwoodTerminal) {
  const frame = readClaudeInputCursor(terminal)?.frame;
  if (!frame) return undefined;
  const shape = { composer: claudeWorkingComposerRow, footer: claudeWorkingFooter };
  return emptyComposerRows(frame.lines, frame.cursorY, shape) ? frame : undefined;
}

/**
 * Whether the live rows show Claude's empty composer (PRD §5.3, §5.4; C-API-56).
 *
 * `cursorRow` is the native cursor index in these rows. That row must be the empty
 * `❯` composer, with the composer's top rule (plain, or labelled by a named session) at
 * `cursorRow - 1` and a plain bottom rule at `cursorRow + 1`.
 *
 * The footer is the row directly under the bottom rule, `cursorRow + 2`: a permission-mode
 * footer (`claudeComposerFooter`) or, when the caller passes `stagedFooter`, one of its
 * staged-input hint rows. That row is the composer's chrome. Without it, the row must be
 * blank or absent and the version banner must be visible somewhere in `rows`; a footer
 * further down never counts. Every non-blank row after it must be a footer item on its own
 * row (`claudeFooterOverflow`: a token count or effort level), the login-renewal notice, or
 * a `stagedFooter` row.
 */
export function claudeEmptyInputRows(
  rows: readonly string[],
  cursorRow: number,
  stagedFooter?: RegExp,
): boolean {
  return emptyComposerRows(rows, cursorRow, { composer: claudeComposerRow, footer: stagedFooter });
}

/** The composer row shape, and the footer row accepted besides the idle one. */
type ComposerShape = { readonly composer: RegExp; readonly footer: RegExp | undefined };

function emptyComposerRows(
  rows: readonly string[],
  cursorRow: number,
  { composer: composerRow, footer: extraFooter }: ComposerShape,
): boolean {
  const composer = rows[cursorRow];
  if (!(composer?.startsWith("❯") && composerRow.test(composer))) return false;
  // A named session labels only the top rule; the rule below the composer stays plain.
  const topRule = rows[cursorRow - 1] ?? "";
  const hasComposerTopRule = rule.test(topRule) || claudeNamedBorder.test(topRule);
  const hasPlainBottomRule = rule.test(rows[cursorRow + 1] ?? "");
  if (!(hasComposerTopRule && hasPlainBottomRule)) return false;
  const footer = rows[cursorRow + 2] ?? "";
  const footed = claudeComposerFooter.test(footer) || extraFooter?.test(footer) === true;
  const bannered = footer.trim() === "" && rows.some((row) => /Claude Code v[\d.]+/.test(row));
  return (
    (footed || bannered) &&
    rows
      .slice(cursorRow + 3)
      .every(
        (row) =>
          row.trim() === "" ||
          claudeFooterOverflow.test(row) ||
          loginRenewalNotice.test(row) ||
          extraFooter?.test(row),
      )
  );
}
