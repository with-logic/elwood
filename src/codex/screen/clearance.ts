/**
 * Positive Codex composer evidence for trust clearance, staged recovery and empty input.
 * Implements PRD §5.3/§5.4, C-API-31/C-API-56/C-TRUST-01.
 */

import { codexReasoningEfforts } from "../../core/reasoning-effort.ts";
import { cursorOptionRows } from "../../core/terminal-options.ts";
import { isTrustDialogHeader } from "../../core/trust/dialog.ts";
import { codexWorkingScreen } from "./working.ts";

const caretRow = /^\s*[›»]/;
const composerRowStart = /^[›»](?:\s|$)/;
const approvalHeader = /^(?:Would you like to|Allow command\?)/i;
/** Codex 0.142.5's PLACEHOLDERS plus the captured 0.154.0 default. */
const placeholders = new Set([
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
const effortAndTier = `(?:${codexReasoningEfforts.join("|")}|default)(?: (?:[Ff]ast|[Uu]ltrafast))?`;
const directory = String.raw` · (?:~?\/|[A-Z]:[\\/])[^\n]*`;
// An effort-only footer needs its directory; a bare effort word cannot prove configuration.
const statusFooter = new RegExp(
  String.raw`^ {2}(?:(?:gpt|GPT)-[\w.-]+(?: Terra)? ${effortAndTier}(?:${directory})?|${effortAndTier}${directory})(?: {2,}Plan mode \(⇧tab to cycle\))?$`,
);
const hintFooter =
  /^(?: {2})?(?:← for agents · )?\? for shortcuts(?: +⚠ [1-9]\d* warnings? · f2 to view)?$/;

/** A contiguous startup welcome box and its native tip/warning rows. */
function welcomeBox(rows: readonly string[]): boolean {
  if (!/^╭─+╮$/.test(rows[0] ?? "")) return false;
  if (!/^│\s*>_ OpenAI Codex \(v[\d.]+\)\s*│$/.test(rows[1] ?? "")) return false;
  if (!/^│\s*│$/.test(rows[2] ?? "")) return false;
  if (!/^│ model:\s+\S.*\s+\/model to change\s*│$/.test(rows[3] ?? "")) return false;
  if (!/^│ directory:\s+\S.*│$/.test(rows[4] ?? "")) return false;
  if (!/^╰─+╯$/.test(rows[5] ?? "")) return false;
  let inTip = false;
  return rows.slice(6).every((row) => {
    if (row === "") return true;
    if (/^ {2}Tip: /.test(row)) {
      inTip = true;
      return true;
    }
    if (/^⚠ /.test(row)) {
      inTip = false;
      return true;
    }
    return inTip && /^ {2}\S/.test(row);
  });
}

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
    if (liveCursor && /^• \S/.test(row) && !codexWorkingScreen.test(row)) {
      quoted = true;
      return "";
    }
    if (quoted && /^ {2,}\S/.test(row)) return "";
    quoted = false;
    return row;
  });
}

/** A native reply bounds consecutive user/question-answer echoes, including wrapped text. */
function completeUserHistoryEnd(rows: readonly string[], start: number): number {
  let end = start + 1;
  for (; end < rows.length; end++) {
    const row = rows[end] as string;
    if (row === "" || /^ {2,}\S/.test(row) || isUserHistoryRow(row, rows, end)) continue;
    return /^• \S/.test(row) && !codexWorkingScreen.test(row) ? end : start;
  }
  return start;
}

/** Native dialog evidence survives even when its choices/footer have not painted. */
function hasNativeDialogEvidence(rows: readonly string[], liveCursor: boolean): boolean {
  const unquoted = unquotedRows(rows, liveCursor);
  for (const row of unquoted) {
    if (
      row.trim() === "Folder access" ||
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

/** Locate a composer by retained footer evidence or a live-verified welcome region. */
export function codexComposerRow(frameRows: readonly string[], liveClear: boolean): number {
  const at = frameRows.findLastIndex(
    (row) => composerRowStart.test(row) && placeholders.has(row.slice(1).trim()),
  );
  // Submitted transcript prompts can exactly match a placeholder; native chrome
  // must remain too. Welcome chrome also survives in transcripts, so it requires
  // live cursor verification before it can preserve the composer's provenance.
  return at >= 0 && nativeComposerRegion(frameRows, at, liveClear) ? at : -1;
}

/**
 * Codex paints its status footer beneath the composer once its session is configured.
 * The composer it paints while booting has none, and under load its directory-trust gate
 * can follow seconds later, so readiness waits for this footer (C-API-28).
 */
export function codexComposerConfigured(frame: string): boolean {
  const rows = frame.split("\n").map((row) => row.trimEnd());
  const at = rows.findLastIndex((row) => composerRowStart.test(row));
  return at >= 0 && nativeComposerRegion(rows, at, false);
}

/** Require the composer's own footer unless the caller permits welcome evidence. */
function nativeComposerRegion(rows: readonly string[], at: number, allowWelcome: boolean): boolean {
  // Native Codex right-aligns this badge even with a model-only status line.
  const below = rows
    .slice(at + 1)
    .map((row) => row.replace(/ {2,}⚠ [1-9]\d* warnings? · f2 to view\s*$/, "").trimEnd())
    .filter((row) => row !== "");
  if (!below.every((row) => statusFooter.test(row) || hintFooter.test(row))) return false;
  return (
    below.some((row) => statusFooter.test(row)) ||
    (allowWelcome && welcomeBox(rows.slice(0, at).map((row) => row.trimEnd())))
  );
}

/**
 * The last composer needs its own status footer or the verified welcome box above
 * it. A stale footer cannot vouch for a bare caret, which is also how a dialog
 * selection starts; ordinary numbered transcript content can precede the composer.
 */
export function codexComposerClearance(frame: string, cursorRow?: number): boolean {
  return codexComposerRowsClearance(frame.split("\n"), cursorRow);
}

/** Classify existing snapshot rows without splitting another viewport string. */
export function codexComposerRowsClearance(
  frameRows: readonly string[],
  cursorRow?: number,
): boolean {
  if (frameRows.some((row) => codexWorkingScreen.test(row))) return false;
  return codexComposerRowsEmpty(frameRows, cursorRow);
}

/** Empty input does not imply an idle turn; callers choose the activity contract. */
export function codexComposerRowsEmpty(frameRows: readonly string[], cursorRow?: number): boolean {
  const rows = frameRows.map((row) => row.trimEnd());
  const at = cursorRow ?? rows.findLastIndex((row) => caretRow.test(row));
  const composer = rows[at];
  // Native composer starts at column zero; transcript continuations are indented.
  if (composer === undefined || !composerRowStart.test(composer)) return false;
  if (!placeholders.has(composer.slice(1).trim())) return false;
  const above = rows.slice(0, at);
  // A partially painted native approval overrides a cursor left on the old composer.
  // Indentation and a retained cursor do not turn native approval rows into history.
  if (hasNativeDialogEvidence(above, cursorRow !== undefined)) return false;
  return nativeComposerRegion(rows, at, true);
}
