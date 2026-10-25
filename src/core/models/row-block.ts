/**
 * The one contiguous block of option rows inside a native model dialog, fed line by line.
 * Split from `dialog-region.ts`, which decides what may surround the block. Implements
 * C-API-24.
 */

import { rowPattern } from "./rows.ts";

export const caretRow = /^\s*[❯›]/;
export const numberedRow = /^\s*[❯›]?\s*(\d+)[.)]\s/;

/**
 * How a CLI windows a list longer than its viewport, for the adapter that does. `above`
 * and `below` each match a row's start through the marker it wears in the cursor column
 * while rows are hidden above the window (its first visible row) or below it (its last);
 * `overflow` is the line that may stand directly under that last row while any are hidden.
 */
export type ScrollGrammar = {
  readonly above: RegExp;
  readonly below: RegExp;
  readonly overflow: RegExp;
};

/** `line` with a leading scroll marker blanked, so it reads as an ordinary option row. */
export function unmarkedRow(line: string, scroll: ScrollGrammar | undefined): string {
  const marker = [scroll?.above, scroll?.below].find((pattern) => pattern?.test(line));
  return marker === undefined ? line : line.replace(marker, (start) => " ".repeat(start.length));
}

export class RowBlock {
  rowCount = 0;
  cursorCount = 0;
  private next = 1;
  /**
   * A `below` row, or the overflow line under it, ended the window: no later row belongs to
   * it. A window at the bottom of the list has neither; the dialog's footer ends it.
   */
  private windowEnded = false;
  /** The last line accepted was a row: the only line the overflow line may stand under. */
  private lastWasRow = false;
  private readonly complete: boolean;
  private readonly scroll: ScrollGrammar | undefined;
  constructor(options: {
    readonly complete: boolean;
    readonly scroll: ScrollGrammar | undefined;
  }) {
    this.complete = options.complete;
    this.scroll = options.scroll;
  }

  /**
   * Whether `line` extends the block: its next row or, on a windowed list, the overflow line
   * directly under its last row. A COMPLETE dialog's rows are full picker rows
   * (`1. Label  Description`); while a candidate is still painting, a numbered row whose
   * description has not arrived yet counts too, so the shell keeps holding input. Anything
   * else — a renumbered second list, a row after the window ended, a scroll marker the
   * CLI's grammar does not define — is not this dialog's.
   */
  accept(line: string): boolean {
    const followsRow = this.lastWasRow;
    this.lastWasRow = false;
    if (followsRow && this.scroll?.overflow.test(line) === true) {
      this.windowEnded = true;
      return true;
    }
    const row = unmarkedRow(line, this.scroll);
    if (this.windowEnded || !this.isRow(line, row)) return false;
    this.rowCount += 1;
    this.next = Number(numberedRow.exec(row)?.[1]) + 1;
    this.windowEnded = this.scroll?.below.test(line) === true;
    if (caretRow.test(row)) this.cursorCount += 1;
    this.lastWasRow = true;
    return true;
  }

  /**
   * Whether `row` (`line` with any scroll marker blanked) is the block's next row. Only the
   * FIRST row may be numbered past 1, and only under an `above` marker: a window scrolled
   * down hides the rows above it, but an unmarked list that starts at 3 is someone else's,
   * and an `above` marker below the first row is not a window.
   */
  private isRow(line: string, row: string): boolean {
    if (!(rowPattern.test(row) || (!this.complete && numberedRow.test(row)))) return false;
    const number = Number(numberedRow.exec(row)?.[1]);
    if (this.scroll?.above.test(line) === true) return this.rowCount === 0 && number > 1;
    return number === this.next;
  }
}
