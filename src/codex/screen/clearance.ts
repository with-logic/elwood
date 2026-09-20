/** Positive native Codex composer evidence for dialog clearance (PRD §5.4, C-TRUST-01). */

import { cursorOptionRows } from "../../core/terminal-options.ts";
import { codexWorkingScreen } from "./working.ts";

const caretRow = /^\s*›/;
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
function partialDialog(rows: readonly string[]): boolean {
  if (rows.some((row) => /^\s*(?:Would you like to|Allow command\?)/i.test(row))) return true;
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

/**
 * Only the last composer and the native rows below it can prove clearance. Earlier
 * numbered rows can be transcript content; an earlier footer cannot vouch for a
 * newly painted bare caret, which is also how a dialog's selected option starts.
 */
export function codexComposerClearance(frame: string): boolean {
  if (codexWorkingScreen.test(frame)) return false;
  const rows = frame.split("\n").map((row) => row.trimEnd());
  const at = rows.findLastIndex((row) => caretRow.test(row));
  const composer = rows[at];
  // Native composer starts at column zero; transcript continuations are indented.
  if (composer === undefined || !/^›(?:\s|$)/.test(composer)) return false;
  if (!placeholders.has(composer.slice(1).trim())) return false;
  if (partialDialog(rows.slice(0, at))) return false;
  const below = rows.slice(at + 1).filter((row) => row !== "");
  if (!below.every((row) => modelFooter.test(row) || hintFooter.test(row))) return false;
  if (below.some((row) => modelFooter.test(row))) return true;
  // A captured welcome box also anchors the known placeholder. A bare caret alone
  // remains ambiguous even when an old welcome box is still visible above it.
  return welcomeBox(rows.slice(0, at));
}
