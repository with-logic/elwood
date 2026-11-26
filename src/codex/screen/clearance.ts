/**
 * Positive Codex composer evidence for trust clearance, staged recovery and empty input.
 * Implements PRD §5.3/§5.4, C-API-31/C-API-56/C-TRUST-01/C-ATTN-02.
 */

import { cursorOptionRows } from "../../core/terminal-options.ts";
import { isTrustDialogHeader } from "../../core/trust/dialog.ts";
import { classifyCodexFooter, unknownCols } from "./footer.ts";
import { codexWelcomeBox } from "./welcome.ts";
import { codexWorkingScreen } from "./working.ts";
import { isFolderAccessPrelude } from "./workspace-trust-copy.ts";

type ComposerGeometry = { readonly cursorRow?: number; readonly cols?: number | undefined };

const caretRow = /^\s*[›»]/;
export const composerRowStart = /^[›»](?:\s|$)/;
const approvalHeader = /^(?:Would you like to|Allow command\?)/i;
// The first row of a native transcript cell: a reply or tool cell (`• `), or the cell Codex 0.172
// draws for a question it asks (`? `; 0.163 drew `• `). The working row shares the bullet but is
// not a cell.
const startsTranscriptCell = (row: string): boolean =>
  /^[•?] \S/.test(row) && !codexWorkingScreen.test(row);
/** Codex 0.142.5's PLACEHOLDERS plus the captured 0.154.0 default. */
export const codexPlaceholders: ReadonlySet<string> = new Set([
  "Ask Codex to do anything",
  "Explain this codebase",
  "Summarize recent commits",
  "Implement {feature}",
  "Find and fix a bug in @filename",
  "Write tests for @filename",
  "Improve documentation in @filename",
  "Run /review on my current changes",
  "Use /skills to list available skills",
]);
function isUserHistoryRow(row: string, rows: readonly string[], index: number): boolean {
  const isPromptRow = /^[›»] \S/.test(row);
  const isNumberedOptionRow = /^[›»] \d+[.)]/.test(row) && numberedSibling(rows, index);
  return isPromptRow && !isNumberedOptionRow;
}

/** Preserve row boundaries when excluding complete user history or assistant quotation. */
function unquotedRows(rows: readonly string[], liveCursor: boolean): readonly string[] {
  let quoted = false;
  let userEnd = -1;
  return rows.map((row, index) => {
    if (liveCursor && isUserHistoryRow(row, rows, index))
      userEnd = completeUserHistoryEnd(rows, index);
    if (index < userEnd) return "";
    if (liveCursor && startsTranscriptCell(row)) {
      quoted = true;
      return "";
    }
    if (quoted && /^ {2,}\S/.test(row)) return "";
    quoted = false;
    return row;
  });
}

/** A transcript cell bounds consecutive user/question-answer echoes, including wrapped text. */
function completeUserHistoryEnd(rows: readonly string[], start: number): number {
  let end = start + 1;
  for (; end < rows.length; end++) {
    const row = rows[end] as string;
    if (row === "" || /^ {2,}\S/.test(row) || isUserHistoryRow(row, rows, end)) continue;
    return startsTranscriptCell(row) ? end : start;
  }
  return start;
}

/** Native dialog evidence survives even when its choices/footer have not painted. */
export function hasNativeDialogEvidence(rows: readonly string[], liveCursor: boolean): boolean {
  const unquoted = unquotedRows(rows, liveCursor);
  for (const row of unquoted) {
    if (
      isFolderAccessPrelude(row) ||
      approvalHeader.test(row.trimStart()) ||
      isTrustDialogHeader(row) ||
      /^\s*[›»❯>]\s*\d+[.)]\s*\S/.test(row) ||
      /^\s*(?:[›»❯>]\s*)?\d+[.)]\s*(?:Yes|No)\b/i.test(row)
    )
      return true;
  }
  // A live input cursor can coexist with quoted menus in transcript history, but
  // cannot override approval fragments outside a bounded assistant quotation.
  if (liveCursor && unquoted.some((row) => /^\s*❯\s+\S/.test(row))) return true;
  if (!liveCursor && rows.some((row) => /^\s*[›»❯]\s+(?:Yes|No)\b/i.test(row))) return true;
  let startRow = 0;
  for (;;) {
    const cursor = cursorOptionRows(unquoted, startRow);
    if (cursor === undefined) return false;
    if (cursor.lastRow > cursor.firstRow) return true;
    startRow = cursor.lastRow + 1;
  }
}

/** A standalone numbered user prompt is not a native option block. */
function numberedSibling(rows: readonly string[], index: number): boolean {
  return [rows[index - 1], rows[index + 1]].some(
    (row) => row !== undefined && /^\s*(?:[›»❯>]\s*)?\d+[.)]\s*\S/.test(row),
  );
}

/**
 * Locate a composer by retained footer evidence or a live-verified welcome region. Here and
 * below, `cols` is the width of the terminal that drew the rows: without it (`unknownCols`)
 * a wrapped status footer is not evidence (C-CODEX-26).
 */
export function codexComposerRow(
  frameRows: readonly string[],
  liveClear: boolean,
  cols = unknownCols,
): number {
  const at = frameRows.findLastIndex(
    (row) => composerRowStart.test(row) && codexPlaceholders.has(row.slice(1).trim()),
  );
  // Submitted transcript prompts can exactly match a placeholder; native chrome
  // must remain too. Welcome chrome also survives in transcripts, so it requires
  // live cursor verification before it can preserve the composer's provenance.
  return at >= 0 && nativeComposerRegion(frameRows, at, liveClear, cols) ? at : -1;
}

/**
 * Codex paints its status footer beneath the composer once its model catalog loads. The
 * composer it paints while booting has none, and under load its directory-trust gate can
 * follow seconds later, so readiness waits for this footer (C-API-28). Codex 0.172 paints
 * the footer before it applies the session's configuration, which discards a mode or model
 * picked before it, and labels the effort `default` until then. A session that requested an
 * effort Codex labels (`effortShown`) therefore also waits for another label. A wrapped
 * footer counts only with the width of the terminal that drew the frame (C-CODEX-26).
 */
export function codexComposerConfigured(
  frame: string,
  cols = unknownCols,
  effortShown = false,
): boolean {
  const rows = frame.split("\n").map((row) => row.trimEnd());
  const at = rows.findLastIndex((row) => composerRowStart.test(row));
  const footer = at >= 0 ? classifyCodexFooter(rows.slice(at + 1), cols) : undefined;
  return footer?.hasStatus === true && !(effortShown && footer.effort === "default");
}

/** Require the composer's own footer unless the caller permits welcome evidence. */
function nativeComposerRegion(
  rows: readonly string[],
  at: number,
  allowWelcome: boolean,
  cols: number,
): boolean {
  const footer = classifyCodexFooter(rows.slice(at + 1), cols);
  if (footer === undefined) return false;
  return (
    footer.hasStatus ||
    (allowWelcome && codexWelcomeBox(rows.slice(0, at).map((row) => row.trimEnd())))
  );
}

/**
 * Require the last composer’s own status footer or the verified welcome box above it.
 * A bare caret may be a dialog selection.
 * A frame's text carries no width: called with the text alone, as a `TrustClearance`, this
 * fails closed on a wrapped footer. A session uses `liveCodexClearance`, which has the width.
 */
export function codexComposerClearance(frame: string, geometry?: ComposerGeometry): boolean {
  return codexComposerRowsClearance(frame.split("\n"), geometry);
}

/** Classify existing snapshot rows without splitting another viewport string. */
export function codexComposerRowsClearance(
  frameRows: readonly string[],
  geometry?: ComposerGeometry,
): boolean {
  if (frameRows.some((row) => codexWorkingScreen.test(row))) return false;
  return codexComposerRowsEmpty(frameRows, geometry);
}

/** Empty input does not imply an idle turn; callers choose the activity contract. */
export function codexComposerRowsEmpty(
  frameRows: readonly string[],
  { cursorRow, cols = unknownCols }: ComposerGeometry = {},
): boolean {
  const rows = frameRows.map((row) => row.trimEnd());
  const at = cursorRow ?? rows.findLastIndex((row) => caretRow.test(row));
  const composer = rows[at];
  // Native composer starts at column zero; transcript continuations are indented.
  if (composer === undefined || !composerRowStart.test(composer)) return false;
  if (!codexPlaceholders.has(composer.slice(1).trim())) return false;
  const above = rows.slice(0, at);
  // A partially painted native approval overrides a cursor left on the old composer.
  // Indentation and a retained cursor do not turn native approval rows into history.
  if (hasNativeDialogEvidence(above, cursorRow !== undefined)) return false;
  return nativeComposerRegion(rows, at, true, cols);
}
