/**
 * Reads a session's live screen as text, with optional scrollback, from the headless
 * terminal. Implements PRD §5.14 and C-SCREEN-01 through C-SCREEN-03.
 */
import { parsedCursorVisible, terminalDisposed } from "./cursor.ts";
import type { ElwoodTerminal } from "./headless.ts";
import { bufferRows } from "./snapshot.ts";

export type ReadScreenOptions = {
  /**
   * `true` for every retained row, or at most this many rows nearest the live screen.
   * A number that is not a non-negative integer rejects with a `TypeError`.
   */
  readonly scrollback?: boolean | number;
};

export type ElwoodScreen = {
  readonly cols: number;
  readonly rows: number;
  /** The live screen: exactly `rows` entries, top to bottom, right-trimmed. */
  readonly lines: readonly string[];
  /** Rows above the live screen, oldest first. Empty unless requested. */
  readonly scrollback: readonly string[];
  /** The terminal cursor's cell on the live screen. */
  readonly cursor: {
    /** Zero-based column, not a string index. Equals `cols` while it waits past the last column. */
    readonly x: number;
    /** Zero-based row, an index into `lines`. */
    readonly y: number;
    /** The terminal cursor mode (DECTCEM). A CLI that hides it may draw a cursor of its own. */
    readonly visible: boolean;
  };
  readonly buffer: "normal" | "alternate";
  /**
   * True once Elwood failed to draw output it received, so the text may be missing some.
   * False does not mean the screen holds everything the CLI printed (§5.14).
   */
  readonly outputLost: boolean;
};

export interface ScreenControls {
  /**
   * Read the live screen as text, whatever viewport the host selected. Waits, with no
   * timeout, until received output has rendered. Works after exit until the terminal is
   * disposed, then rejects with `session_not_running`.
   */
  readScreen(options?: ReadScreenOptions): Promise<ElwoodScreen>;
}

/** The screen once received output has rendered, or undefined once the terminal is disposed. */
export async function readTerminalScreen(
  terminal: ElwoodTerminal,
  options: ReadScreenOptions = {},
): Promise<ElwoodScreen | undefined> {
  const limit = scrollbackLimit(options.scrollback);
  await terminal.settled();
  const { xterm } = terminal;
  // Disposal also ends a pending settle, so check for it only after the wait.
  if (terminalDisposed(xterm)) return undefined;
  const buffer = xterm.buffer.active;
  // `baseY` is the first live row. `viewportY` would follow the host's scroll position.
  const firstLiveRow = buffer.baseY;
  const scrollbackCount = Math.min(limit, firstLiveRow);
  return {
    cols: xterm.cols,
    rows: xterm.rows,
    lines: bufferRows(xterm, { firstRow: firstLiveRow, rowCount: xterm.rows }),
    scrollback: bufferRows(xterm, {
      firstRow: firstLiveRow - scrollbackCount,
      rowCount: scrollbackCount,
    }),
    cursor: { x: buffer.cursorX, y: buffer.cursorY, visible: parsedCursorVisible(xterm) },
    buffer: buffer.type,
    outputLost: terminal.renderFailed,
  };
}

function scrollbackLimit(scrollback: boolean | number = false): number {
  if (typeof scrollback === "boolean") return scrollback ? Number.POSITIVE_INFINITY : 0;
  if (Number.isInteger(scrollback) && scrollback >= 0) return scrollback;
  throw new TypeError("readScreen: scrollback must be a boolean or a non-negative integer.");
}
