/** Claude collapsed text chips count only inside the live idle composer (PRD §5.3). */
import { stagedComposer } from "../../core/input/staged-composer.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { claudeScreenFactTable } from "../screen-table.ts";
import { claudeEmptyInputRows } from "./empty-input.ts";

// Captured Claude 2.1.281 staged-only hints; these do not establish empty input.
const stagedFooter =
  /^\s*(?:paste again to expand(?: +[\d,.]+[kKmM]? tokens)?|Ctrl\+Y to paste deleted text|ctrl\+g to edit in Nvim)\s*$/;
const stagedRows = (rows: readonly string[], cursorRow: number) =>
  claudeEmptyInputRows(rows, cursorRow, stagedFooter);

export function claudeTextStaged(terminal: ElwoodTerminal): boolean {
  return /\[Pasted text/.test(
    stagedComposer(terminal, stagedRows, claudeScreenFactTable, "❯ ") ?? "",
  );
}
