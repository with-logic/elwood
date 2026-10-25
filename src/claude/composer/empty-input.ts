/** Observe native empty Claude input without requiring an idle turn (PRD §5.3, C-API-56). */
import { emptyInputFrame } from "../../core/input/empty-frame.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { loginRenewalNotice } from "../login/notice.ts";
import { claudeComposerRow } from "../screen-table.ts";
import { claudeNamedBorder } from "./border.ts";
import { claudeComposerFooter, claudeFooterOverflow } from "./footer.ts";

const rule = /^[─━]{3,}\s*$/;
export function claudeEmptyInputFrame(terminal: ElwoodTerminal) {
  return emptyInputFrame(terminal, claudeEmptyInputRows);
}

/**
 * Whether viewport `rows` show Claude's live, empty composer (PRD §5.3, §5.4; C-API-56).
 *
 * `cursorRow` is the viewport index of the terminal cursor's row. That row must be the empty
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
  const composer = rows[cursorRow];
  if (!(composer?.startsWith("❯") && claudeComposerRow.test(composer))) return false;
  // A named session labels only the top rule; the rule below the composer stays plain.
  const topRule = rows[cursorRow - 1] ?? "";
  const hasComposerTopRule = rule.test(topRule) || claudeNamedBorder.test(topRule);
  const hasPlainBottomRule = rule.test(rows[cursorRow + 1] ?? "");
  if (!(hasComposerTopRule && hasPlainBottomRule)) return false;
  const footer = rows[cursorRow + 2] ?? "";
  const footed = claudeComposerFooter.test(footer) || stagedFooter?.test(footer) === true;
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
          stagedFooter?.test(row),
      )
  );
}
