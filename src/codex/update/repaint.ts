/**
 * What Codex draws after Elwood skips its update prompt (PRD §5.5, C-CODEX-27). Codex 0.171
 * and later first repaint the screen the prompt replaced, the boot composer on a start or
 * the `Resuming session…` placeholder on a resume, and then the configured composer.
 */
import { codexPlaceholders, hasNativeDialogEvidence } from "../screen/clearance.ts";
import { classifyCodexFooter, unknownCols } from "../screen/footer.ts";

const composerRow = /^[›»](?:\s|$)/;
const numberedChoice = /^[›»]\s*\d+[.)]\s*\S/;

/**
 * A native dialog: the last caret row selects a numbered choice, or the rows above it hold
 * dialog chrome outside user history and assistant replies (C-TRUST-01 evidence).
 */
export function codexDialogShown(frame: string): boolean {
  const rows = frame.split("\n");
  const at = rows.findLastIndex((row) => composerRow.test(row));
  if (numberedChoice.test(rows[at] ?? "")) return true;
  return hasNativeDialogEvidence(at < 0 ? rows : rows.slice(0, at), true);
}

/**
 * Codex's boot composer or resume placeholder: its last composer row holds a native
 * placeholder over the shortcuts hint, with no status row, and no dialog is drawn. With a status row it
 * would be the configured composer, which only live clearance confirms (C-CODEX-12).
 */
export function codexRepaintComposerShown(frame: string): boolean {
  if (codexDialogShown(frame)) return false;
  const rows = frame.split("\n").map((row) => row.trimEnd());
  const at = rows.findLastIndex((row) => composerRow.test(row));
  const row = rows[at];
  if (row === undefined || !codexPlaceholders.has(row.slice(1).trim())) return false;
  // Without a status row, any footer row left is the hint.
  const below = rows.slice(at + 1);
  return classifyCodexFooter(below, unknownCols)?.hasStatus === false && below.some(Boolean);
}
