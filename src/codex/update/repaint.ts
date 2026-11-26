/**
 * What Codex draws after Elwood skips its update prompt (PRD §5.5, C-CODEX-27). Codex 0.171
 * and later first repaint the screen the prompt replaced, the boot composer on a start or
 * the `Resuming session…` placeholder on a resume, and then the configured composer.
 */
import {
  codexPlaceholders,
  composerRowStart,
  hasNativeDialogEvidence,
} from "../screen/clearance.ts";
import { classifyCodexFooter, unknownCols } from "../screen/footer.ts";

const numberedChoice = /^[›»]\s*\d+[.)]\s*\S/;
/**
 * The rows above Codex's composer are its transcript, as on a live screen, so user history
 * and assistant replies there are not dialog evidence.
 */
const transcriptAboveComposer = true;

/**
 * A native dialog: the last caret row selects a numbered choice, or the rows above it hold
 * dialog chrome outside user history and assistant replies (C-TRUST-01 evidence).
 */
export function codexDialogVisible(frame: string): boolean {
  const rows = frame.split("\n");
  const at = rows.findLastIndex((row) => composerRowStart.test(row));
  if (numberedChoice.test(rows[at] ?? "")) return true;
  return hasNativeDialogEvidence(at < 0 ? rows : rows.slice(0, at), transcriptAboveComposer);
}

/**
 * Codex's boot composer or resume placeholder, the composer before Codex paints its status
 * footer: its last composer row holds a native placeholder over the shortcuts hint, with no
 * status row, and no dialog is drawn. With a status row it would be the configured composer,
 * which only live clearance confirms (C-CODEX-12).
 */
export function codexUnconfiguredComposerVisible(frame: string): boolean {
  if (codexDialogVisible(frame)) return false;
  const rows = frame.split("\n").map((row) => row.trimEnd());
  const at = rows.findLastIndex((row) => composerRowStart.test(row));
  const row = rows[at];
  if (row === undefined || !codexPlaceholders.has(row.slice(1).trim())) return false;
  // Without a status row, any footer row left is the hint.
  const below = rows.slice(at + 1);
  return classifyCodexFooter(below, unknownCols)?.hasStatus === false && below.some(Boolean);
}
