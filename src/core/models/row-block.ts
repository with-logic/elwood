/**
 * The one contiguous block of option rows inside a native model dialog, fed line by line.
 * Split from `dialog-region.ts`, which decides what may surround the block. Implements
 * C-API-24.
 */

import { rowPattern } from "./rows.ts";

export const caretRow = /^\s*[❯›]/;
export const numberedRow = /^\s*[❯›↑↓]?\s*(\d+)[.)]\s/;
// Claude windows a list longer than ten rows: `↑` marks the first visible row when rows are
// hidden above it, `↓` the last when rows are hidden below, and `… +3 models` (`… +1 model`)
// sits directly under the last row while any are. The cursor glyph replaces either marker.
const scrollMarker = /^\s*[↑↓]/;
const scrolledAbove = /^\s*↑/;
const scrolledBelow = /^\s*↓/;
const overflowRow = /^\s*…\s*\+\d+ models?\s*$/;

export class RowBlock {
  rowCount = 0;
  cursorCount = 0;
  private next = 1;
  /** The block's last row has painted: a `↓` row or the overflow line beneath the last row. */
  private closed = false;
  private afterRow = false;
  private readonly complete: boolean;
  private readonly scrolls: boolean;
  constructor(options: { readonly complete: boolean; readonly scrolls: boolean }) {
    this.complete = options.complete;
    this.scrolls = options.scrolls;
  }

  /**
   * Whether `line` extends the block: its next row or, on a list that scrolls, the overflow
   * line directly under its last row. A COMPLETE dialog's rows are full picker rows
   * (`1. Label  Description`); while a candidate is still painting, a numbered row whose
   * description has not arrived yet counts too, so the shell keeps holding input. Anything
   * else — a renumbered second list, a row below the block's last, a scroll marker on a
   * list that does not scroll — is not this dialog's.
   */
  accept(line: string): boolean {
    if (this.scrolls && this.afterRow && overflowRow.test(line)) {
      this.closed = true;
      this.afterRow = false;
      return true;
    }
    const candidateRow = !this.complete && numberedRow.test(line);
    this.afterRow =
      !this.closed && (rowPattern.test(line) || candidateRow) && this.inSequence(line);
    if (!this.afterRow) return false;
    this.rowCount += 1;
    this.next = Number(numberedRow.exec(line)?.[1]) + 1;
    this.closed = scrolledBelow.test(line);
    if (caretRow.test(line)) this.cursorCount += 1;
    return true;
  }

  /**
   * Whether a row continues the numbering. Only the FIRST row may be numbered past 1, and
   * only under `↑`: a window scrolled down hides the rows above it, but an unmarked list
   * that starts at 3 is someone else's, and `↑` below the first row is not a window.
   */
  private inSequence(line: string): boolean {
    if (!this.scrolls && scrollMarker.test(line)) return false;
    const number = Number(numberedRow.exec(line)?.[1]);
    if (scrolledAbove.test(line)) return this.rowCount === 0 && number > 1;
    return number === this.next;
  }
}
