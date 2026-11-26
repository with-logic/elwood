/**
 * Claude staged text and image chips count only inside the live idle composer (PRD §5.3).
 * A staged draft in that composer is also attention clearance (C-ATTN-02, C-ATTN-09).
 */
import {
  readCandidateComposerFrame,
  readStagedComposer,
  readStagedComposerFrame,
} from "../../core/input/staged-composer.ts";
import type { TrustClearance } from "../../core/trust/clearance.ts";
import type { ElwoodTerminal } from "../../terminal/headless.ts";
import { claudeScreenFactTable } from "../screen-table.ts";
import { claudeEmptyInputFrame, claudeEmptyInputRows } from "./empty-input.ts";
import { claudeTokenCount } from "./footer.ts";

// Captured Claude 2.1.281 staged-only hints; these do not establish empty input.
const stagedFooter = new RegExp(
  String.raw`^\s*(?:paste again to expand(?: +${claudeTokenCount})?|Ctrl\+Y to paste deleted text|ctrl\+g to edit in Nvim)\s*$`,
);
const matchesEmptyInputWithStagedFooter = (rows: readonly string[], cursorRow: number) =>
  claudeEmptyInputRows(rows, cursorRow, stagedFooter);

export function claudeInputStaged(terminal: ElwoodTerminal): boolean {
  return /\[Pasted text|\[Image #\d+\]/.test(
    readStagedComposer(terminal, matchesEmptyInputWithStagedFooter, claudeScreenFactTable, "❯ ") ??
      "",
  );
}

/**
 * True when `text` is the live frame and it shows Claude's verified composer holding a
 * staged draft, text or pill, with no dialog or working indicator. A paste written just
 * before a dialog painted is still staged when the dialog closes, so this frame, not an
 * empty composer, is what lets that paste's held Enter submit it.
 */
export function claudeStagedComposerClearance(readTerminal: () => ElwoodTerminal): TrustClearance {
  return (text) => {
    const current = readCandidateComposerFrame(readTerminal(), claudeScreenFactTable);
    return (
      current?.frame.text === text &&
      readStagedComposerFrame(current, matchesEmptyInputWithStagedFooter, "❯ ") !== undefined
    );
  };
}

export function createClaudeRecoveryComposer(terminal: ElwoodTerminal) {
  return {
    prepareStaged: () => () => claudeInputStaged(terminal),
    emptyFrame: () => claudeEmptyInputFrame(terminal),
  };
}
