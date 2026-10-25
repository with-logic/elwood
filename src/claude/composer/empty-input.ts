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
  const below = rows.slice(cursorRow + 2).filter((row) => row.trim() !== "");
  return (
    (rows.some((row) => /Claude Code v[\d.]+/.test(row)) ||
      below.some((row) => claudeComposerFooter.test(row) || stagedFooter?.test(row))) &&
    below.every(
      (row) =>
        claudeComposerFooter.test(row) ||
        claudeFooterOverflow.test(row) ||
        loginRenewalNotice.test(row) ||
        stagedFooter?.test(row),
    )
  );
}
