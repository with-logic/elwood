/**
 * Recognizes a live model dialog as the bottom-most NATIVE region of the viewport, under
 * the authority of the transaction that opened it. Split from `rows.ts` (which parses the
 * rows themselves) to keep each file within the size cap. Implements C-API-24.
 */

import { caretRow, numberedRow, RowBlock, type ScrollGrammar } from "./row-block.ts";

/**
 * What one CLI's model dialog looks like beyond the shared block rules. Each adapter owns
 * its own, so one CLI's layout change cannot widen what counts as the other's dialog.
 */
export type DialogGrammar = {
  /** The dialog's title. */
  readonly header: RegExp;
  /** The phrase the closing hint row carries (`Esc to cancel`), matched in hint clauses only. */
  readonly footer: RegExp;
  /** A row of the CLI's own that may sit between the rows and the footer. */
  readonly controlRow?: RegExp;
  /** How the CLI windows a list longer than its viewport, if it does. */
  readonly scroll?: ScrollGrammar;
};

// An agent reply or the composer renders below any header the transcript merely quotes.
const replyRow = /^\s*[●•⏺]/;
// Both CLIs separate the transcript from the composer or a lower dialog with one of these.
const blockEnd = /^\s*(?:[─━]{3}.*)?$/;
// The closing hint row is ONLY hints — `key to action` clauses joined by `·` — so the footer
// phrase cannot be matched inside a sentence of the agent's own prose that mentions Esc.
const hintClause = /^[^.!?]{0,48}$/;

/** A closing hint row: the footer phrase standing on its own row, not buried in prose. */
function isFooterRow(line: string, grammar: DialogGrammar): boolean {
  if (!grammar.footer.test(line)) return false;
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
 * control row is checked first: Claude's High-effort row (`● High effort …`) wears a bullet.
 */
function mayAppearBesideRows(line: string, rowsStarted: boolean, grammar: DialogGrammar) {
  if (rowsStarted && grammar.controlRow?.test(line) === true) return true;
  if (replyRow.test(line) || caretRow.test(line) || numberedRow.test(line)) return false;
  if (!rowsStarted) return true;
  return blockEnd.test(line) || isFooterRow(line, grammar);
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
 * lacks the description column, so none of them can pass for the dialog. A windowed
 * list (Claude's, longer than ten rows) is the one block that may start past 1: its first
 * row wears the grammar's `above` marker, a `below` row ends it, and its overflow line
 * (`… +K models`) may stand only directly under its last row.
 *
 * Nothing missing and nothing after: the block renders at least two numbered rows and
 * then the CLI's closing hint row, which TERMINATES it — only blank lines and rules may
 * follow. A header alone, a header above a trust or hook prompt, a picker still painting
 * its rows, and a complete quoted picker with a live prompt below it all fail one of
 * these, so none is a dialog Elwood may drive.
 *
 * `lines` always starts at the matched header row, so `header` is never absent.
 */
function isNativeRegion(lines: readonly string[], grammar: DialogGrammar, complete: boolean) {
  const [header, ...body] = lines as [string, ...string[]];
  if (!opensRegion(header)) return false;
  const block = new RowBlock({ complete, scroll: grammar.scroll });
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
    if (!mayAppearBesideRows(line, block.rowCount > 0, grammar)) return false;
    footer = isFooterRow(line, grammar);
  }
  return block.cursorCount <= 1 && (!complete || (footer && block.rowCount >= minimumRows));
}

/**
 * The row of the last header when it opens the bottom-most native region, else -1.
 * Both CLIs replace the composer with the dialog, so a header with anything foreign at
 * or below it is transcript, composer, or another dialog's content. Elwood must neither
 * cancel such text (Escape would interrupt a running turn, clear staged input, or
 * dismiss a human's prompt) nor hold input on it (C-API-24).
 */
export function bottomDialogRow(text: string, grammar: DialogGrammar): number {
  const lines = text.split("\n");
  const start = lines.findLastIndex((line) => grammar.header.test(line));
  // No header, no dialog. Scanning from row 0 instead would ask whether the whole viewport
  // happens to look native, which is a different and much weaker question.
  if (start < 0) return -1;
  return isNativeRegion(lines.slice(start), grammar, true) ? start : -1;
}

/** A bottom-most native picker shell may hold input before its rows/footer finish. */
export function bottomDialogCandidate(text: string, grammar: DialogGrammar): boolean {
  const lines = text.split("\n");
  const start = lines.findLastIndex((line) => grammar.header.test(line));
  return start >= 0 && isNativeRegion(lines.slice(start), grammar, false);
}
