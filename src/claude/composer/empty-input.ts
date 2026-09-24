/** Observe native empty Claude input without requiring an idle turn (PRD §5.3, C-API-56). */
import { emptyInputFrame } from "../../core/input/empty-frame.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { claudeComposerRow } from "../screen-table.ts";

const rule = /^[─━]{3,}\s*$/;
const mode =
  /^\s*(?:-- INSERT -- )?(?:⏵⏵ (?:bypass permissions|don['’]t ask|auto mode) on \(shift\+tab to cycle\)|⏸ manual mode on)(?: · ← for agents)?(?: +[\d,.]+[kKmM]? tokens)?\s*$/;
const expiry = /^\s*Your login expires in \d+ days? · run \/login to renew\s*$/;

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
  if (!(rule.test(rows[cursorRow - 1] ?? "") && rule.test(rows[cursorRow + 1] ?? ""))) return false;
  const below = rows.slice(cursorRow + 2).filter((row) => row.trim() !== "");
  return (
    (rows.some((row) => /Claude Code v[\d.]+/.test(row)) ||
      below.some((row) => mode.test(row) || stagedFooter?.test(row))) &&
    below.every((row) => mode.test(row) || expiry.test(row) || stagedFooter?.test(row))
  );
}
