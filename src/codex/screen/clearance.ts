/** Positive native Codex composer evidence for dialog clearance (PRD §5.4, C-TRUST-01). */

import { cursorOptionRows } from "../../core/terminal-options.ts";
import { codexWorkingScreen } from "./working.ts";

const caretRow = /^\s*›/;
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
const modelFooter =
  /^ {2}gpt-[\w.-]+ (?:minimal|low|medium|high|xhigh|default)(?: · (?:\/|[A-Z]:[\\/])[^\n]*)?$/;
const hintFooter = /^(?: {2})?\? for shortcuts$/;

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

/** Native approval evidence survives even when its footer has not painted. */
function hasApprovalEvidence(rows: readonly string[]): boolean {
  if (rows.some((row) => approvalHeader.test(row.trimStart()))) return true;
  if (
    rows.some((row) => /^\s*(?:[›❯>]\s*\d+[.)]\s*\S|(?:\d+[.)]\s*|[›❯]\s+)(?:Yes|No)\b)/i.test(row))
  )
    return true;
  let remaining = rows;
  for (;;) {
    const cursor = cursorOptionRows(remaining);
    if (cursor === undefined) return false;
    if (cursor.lastRow > cursor.firstRow) return true;
    remaining = remaining.slice(cursor.lastRow + 1);
  }
}

/** Locate a composer by retained footer evidence or a live-verified welcome region. */
export function codexComposerRow(frameRows: readonly string[], liveClear: boolean): number {
  const at = frameRows.findLastIndex(
    (row) => /^›(?:\s|$)/.test(row) && placeholders.has(row.slice(1).trim()),
  );
  // Submitted transcript prompts can exactly match a placeholder; native chrome
  // must remain too. Welcome chrome also survives in transcripts, so it requires
  // live cursor verification before it can preserve the composer's provenance.
  return at >= 0 && nativeComposerRegion(frameRows, at, liveClear) ? at : -1;
}

/** Require the composer's own footer unless the caller permits welcome evidence. */
function nativeComposerRegion(rows: readonly string[], at: number, allowWelcome: boolean): boolean {
  const below = rows
    .slice(at + 1)
    .map((row) => row.trimEnd())
    .filter((row) => row !== "");
  if (!below.every((row) => modelFooter.test(row) || hintFooter.test(row))) return false;
  return (
    below.some((row) => modelFooter.test(row)) ||
    (allowWelcome && welcomeBox(rows.slice(0, at).map((row) => row.trimEnd())))
  );
}

/**
 * The last composer needs its own model footer or the verified welcome box above
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
  const rows = frameRows.map((row) => row.trimEnd());
  const at = cursorRow ?? rows.findLastIndex((row) => caretRow.test(row));
  const composer = rows[at];
  // Native composer starts at column zero; transcript continuations are indented.
  if (composer === undefined || !/^›(?:\s|$)/.test(composer)) return false;
  if (!placeholders.has(composer.slice(1).trim())) return false;
  const above = rows.slice(0, at);
  // A partially painted native approval overrides a cursor left on the old composer.
  // Transcript continuations are indented; user prompts have their own caret prefix.
  if (above.some((row) => approvalHeader.test(row))) return false;
  if (cursorRow === undefined && hasApprovalEvidence(above)) return false;
  return nativeComposerRegion(rows, at, true);
}
