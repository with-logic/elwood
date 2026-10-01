/** Claude staged text and image chips count only inside the live idle composer (PRD §5.3). */
import { readStagedComposer } from "../../core/input/staged-composer.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { claudeScreenFactTable } from "../screen-table.ts";
import { claudeEmptyInputFrame, claudeEmptyInputRows } from "./empty-input.ts";

// Captured Claude 2.1.281 staged-only hints; these do not establish empty input.
const stagedFooter =
  /^\s*(?:paste again to expand(?: +[\d,.]+[kKmM]? tokens)?|Ctrl\+Y to paste deleted text|ctrl\+g to edit in Nvim)\s*$/;
const matchesEmptyInputWithStagedFooter = (rows: readonly string[], viewportCursorRow: number) =>
  claudeEmptyInputRows(rows, viewportCursorRow, stagedFooter);

export function claudeInputStaged(terminal: ElwoodTerminal): boolean {
  return /\[Pasted text|\[Image #\d+\]/.test(
    readStagedComposer(terminal, matchesEmptyInputWithStagedFooter, claudeScreenFactTable, "❯ ") ??
      "",
  );
}

export function createClaudeRecoveryComposer(terminal: ElwoodTerminal) {
  return {
    prepareStaged: () => () => claudeInputStaged(terminal),
    emptyFrame: () => claudeEmptyInputFrame(terminal),
  };
}
