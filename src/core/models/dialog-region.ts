/**
 * Recognizes a live model dialog as the bottom-most NATIVE region of the viewport, under
 * the authority of the transaction that opened it. Split from `rows.ts` (which parses the
 * rows themselves) to keep each file within the size cap. Implements C-API-24.
 */

import { rowPattern } from "./rows.ts";

// An agent reply or the composer renders below any header the transcript merely quotes.
const replyRow = /^\s*[●•⏺]/;
const caretRow = /^\s*[❯›]/;
const numberedRow = /^\s*[❯›↑↓]?\s*(\d+)[.)]\s/;
// Claude windows a list longer than ten rows: `↑` marks the first visible row when rows are
// hidden above it, `↓` the last when rows are hidden below, and `… +3 models` (`… +1 model`)
// sits directly under the last row while any are. The cursor glyph replaces either marker.
const scrolledAbove = /^\s*↑/;
const scrolledBelow = /^\s*↓/;
const overflowRow = /^\s*…\s*\+\d+ models?\s*$/;
// Both CLIs separate the transcript from the composer or a lower dialog with one of these.
const blockEnd = /^\s*(?:[─━]{3}.*)?$/;
// Every captured picker and reasoning screen closes with one of these hint rows. The row is
// ONLY hints — `key to action` clauses joined by `·` — so the phrase cannot be matched
// inside a sentence of the agent's own prose that happens to mention pressing Esc.
const dialogFooter = /\b(?:esc to cancel|esc to go back)\b/i;
const hintClause = /^[^.!?]{0,48}$/;
// Claude paints a radio-style control row under its rows (`◉ xHigh effort ←/→ to adjust`).
// It is part of the dialog, so it may sit between the rows and the footer — but it is a
// marker row, not free prose, which is what keeps this from reopening the mid-list gap.
// Its glyph follows the highlighted model's effort (2.1.310): ○ low, ◐ medium, ● high,
// ◉ xhigh, ◈ max; a model without effort shows `○ Effort not supported for Haiku 4.5`.
// The row is matched by its own copy, because `●` is also a reply bullet.
const controlRow = /^\s*[○◐●◉◈] (?:\S.* ←\/→ to adjust|Effort not supported for \S.*?)\s*$/;

/** A closing hint row: the footer phrase standing on its own row, not buried in prose. */
function isFooterRow(line: string): boolean {
  if (!dialogFooter.test(line)) return false;
  return line
    .split(/[·•]/)
    .every((clause) => hintClause.test(clause.trim()) && clause.trim().length > 0);
}
/** A real picker always offers a choice, so one row is a quoted fragment, not a dialog. */
const minimumRows = 2;

/**
 * A header must be the dialog's own prose. An option or composer row merely containing the
 * phrase is not one, and neither is a reply row: `⏺ Select model` is the agent TALKING
 * about the picker, so treating it as a header would let a reply open a region over its
 * own quoted rows.
 */
function opensRegion(header: string): boolean {
  return !(caretRow.test(header) || numberedRow.test(header) || replyRow.test(header));
}

/**
 * Whether a non-row line may sit inside the dialog without disqualifying it. Never a reply,
 * caret, or numbered row — those belong to the transcript, the composer, or another list.
 * Once the rows have STARTED the block is contiguous (real dialogs paint it in one run), so
 * only a blank or rule, the CLI's own control row (`◉ xHigh effort ←/→ to adjust`), or the
 * closing hint row may appear; free prose mid-list means these rows are not one block. The
 * control row is checked first: a High-effort row (`● High effort …`) wears a reply bullet.
 */
function mayAppearBesideRows(line: string, rowsStarted: boolean): boolean {
  if (rowsStarted && controlRow.test(line)) return true;
  if (replyRow.test(line) || caretRow.test(line) || numberedRow.test(line)) return false;
  if (!rowsStarted) return true;
  return blockEnd.test(line) || isFooterRow(line);
}

/**
 * Whether `lines` (the header row down to the end of the viewport) hold one COMPLETE
 * native dialog and nothing else. Three conditions must all hold.
 *
 * The HEADER is a header. A composer row carrying the phrase (`❯ 1. Select model  draft`)
 * is a caret or numbered row itself, so it can never open a region: that is what let a
 * staged draft satisfy the picker grammar on its own.
 *
 * Nothing foreign: no reply row, and every caret or numbered row belongs to a single
 * contiguous block of picker rows numbered from 1 with at most one cursor. A staged
 * composer line, a permission or approval option, or a second numbered list is on a
 * caret row outside that block, restarts the numbering, follows a blank or rule, or
 * lacks the description column, so none of them can pass for the dialog. A scrolled
 * Claude window is the one block that starts later: its first row carries `↑`, a `↓`
 * row ends it, and its `… +K models` line may stand only directly under its last row.
 *
 * Nothing missing and nothing after: the block renders at least two numbered rows and
 * then the CLI's closing hint row, which TERMINATES it — only blank lines and rules may
 * follow. A header alone, a header above a trust or hook prompt, a picker still painting
 * its rows, and a complete quoted picker with a live prompt below it all fail one of
 * these, so none is a dialog Elwood may drive.
 *
 * `lines` always starts at the matched header row, so `header` is never absent.
 */
function isNativeRegion(lines: readonly string[], complete = true): boolean {
  const [header, ...body] = lines as [string, ...string[]];
  if (!opensRegion(header)) return false;
  const block = new RowBlock(complete);
  let footer = false;
  for (const line of body) {
    // Nothing but blank lines and rules may follow the closing hint row: a complete
    // quoted picker can otherwise sit above a live trust prompt and still read as live.
    // This also subsumes the old "a blank line closes the row block" rule — a second
    // numbered list can no longer reach the rows at all, it is foreign content after
    // the footer, or it breaks the numbering below.
    if (footer) {
      if (!blockEnd.test(line)) return false;
      continue;
    }
    if (block.accept(line)) continue;
    if (!mayAppearBesideRows(line, block.rows > 0)) return false;
    footer = isFooterRow(line);
  }
  return block.cursors <= 1 && (!complete || (footer && block.rows >= minimumRows));
}

/** The dialog's one contiguous block of option rows, fed line by line. */
class RowBlock {
  rows = 0;
  cursors = 0;
  private next = 1;
  /** The block's last row has painted: a `↓` row or the overflow line beneath the last row. */
  private closed = false;
  private afterRow = false;
  private readonly complete: boolean;
  constructor(complete: boolean) {
    this.complete = complete;
  }

  /**
   * Whether `line` extends the block. A row must be a full picker row (`1. Label  Description`)
   * numbered in sequence. Anything else — a renumbered second list, a row without the
   * description column, a row below the block's last — is not this dialog's.
   */
  accept(line: string): boolean {
    if (this.afterRow && overflowRow.test(line)) {
      this.closed = true;
      this.afterRow = false;
      return true;
    }
    const candidateRow = !this.complete && numberedRow.test(line);
    this.afterRow =
      !this.closed &&
      (rowPattern.test(line) || candidateRow) &&
      inSequence(line, this.rows, this.next);
    if (!this.afterRow) return false;
    this.rows += 1;
    this.next = Number(numberedRow.exec(line)?.[1]) + 1;
    this.closed = scrolledBelow.test(line);
    if (caretRow.test(line)) this.cursors += 1;
    return true;
  }
}

/**
 * Whether a row continues the block. Only the FIRST row may be numbered past 1, and only
 * under `↑`: a window scrolled down hides the rows above it, but an unmarked list that
 * starts at 3 is someone else's, and `↑` anywhere below the first row is not a window.
 */
function inSequence(line: string, rows: number, next: number): boolean {
  const number = Number(numberedRow.exec(line)?.[1]);
  if (scrolledAbove.test(line)) return rows === 0 && number > 1;
  return number === next;
}

/**
 * The row of the last `header` when it opens the bottom-most native region, else -1.
 * Both CLIs replace the composer with the dialog, so a header with anything foreign at
 * or below it is transcript, composer, or another dialog's content. Elwood must neither
 * cancel such text (Escape would interrupt a running turn, clear staged input, or
 * dismiss a human's prompt) nor hold input on it (C-API-24).
 */
export function bottomDialogRow(text: string, header: RegExp): number {
  const lines = text.split("\n");
  const start = lines.findLastIndex((line) => header.test(line));
  // No header, no dialog. Scanning from row 0 instead would ask whether the whole viewport
  // happens to look native, which is a different and much weaker question.
  if (start < 0) return -1;
  return isNativeRegion(lines.slice(start)) ? start : -1;
}

/** A bottom-most native picker shell may hold input before its rows/footer finish. */
export function bottomDialogCandidate(text: string, header: RegExp): boolean {
  const lines = text.split("\n");
  const start = lines.findLastIndex((line) => header.test(line));
  return start >= 0 && isNativeRegion(lines.slice(start), false);
}
