/**
 * Reads a session's live screen as text, with optional scrollback, from the headless
 * terminal, and keeps the final screen in memory once that terminal is disposed.
 * Implements PRD §5.14 and C-SCREEN-01 through C-SCREEN-03.
 */
import { parsedCursorVisible } from "./cursor.ts";
import type { ElwoodTerminal, XtermTerminal } from "./headless.ts";
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
  /** Zero-based cell coordinates on the live screen; `x` is a column, not a string index. */
  readonly cursor: { readonly x: number; readonly y: number; readonly visible: boolean };
  readonly buffer: "normal" | "alternate";
  /**
   * True once Elwood failed to draw output it received, or, on a final screen, when the
   * terminal was disposed with received output still undrawn. False does not mean the
   * screen holds everything the CLI printed.
   */
  readonly outputLost: boolean;
};

export interface ScreenControls {
  /**
   * Read the live screen as text, whatever viewport the host selected. Waits, with no
   * timeout, until received output has rendered. Once the terminal is disposed, resolves
   * from memory with the final screen.
   */
  readScreen(options?: ReadScreenOptions): Promise<ElwoodScreen>;
}

type ScreenSource = Pick<ElwoodTerminal, "xterm" | "renderFailed">;

/** A final screen with every retained scrollback row, which each read cuts to its request. */
type RetainedScreen = Omit<ElwoodScreen, "scrollback"> & {
  readonly retainedScrollback: readonly string[];
};

/** Final screens by emulator, which every terminal view of one session shares. Memory only. */
const finalScreens = new WeakMap<XtermTerminal, RetainedScreen>();

/**
 * Keep what a terminal shows as it is disposed, with all its scrollback, which the emulator's
 * limit bounds (1,000 rows by default). `hasUndrawnOutput` marks output it received but never drew.
 */
export function retainFinalScreen(terminal: ScreenSource, hasUndrawnOutput: boolean): void {
  const { scrollback, ...screen } = capture(terminal, Number.POSITIVE_INFINITY);
  const outputLost = screen.outputLost || hasUndrawnOutput;
  finalScreens.set(terminal.xterm, { ...screen, retainedScrollback: scrollback, outputLost });
}

export async function readTerminalScreen(
  terminal: ElwoodTerminal,
  options: ReadScreenOptions = {},
): Promise<ElwoodScreen> {
  const limit = scrollbackLimit(options.scrollback);
  await terminal.settled();
  // Disposal also ends a pending settle, so look for the final screen only after the wait.
  const final = finalScreens.get(terminal.xterm);
  if (final === undefined) return capture(terminal, limit);
  const { retainedScrollback: rows, ...screen } = final;
  // Each read gets its own arrays, so a caller cannot change what later reads return.
  return {
    ...screen,
    lines: [...screen.lines],
    scrollback: rows.slice(rows.length - Math.min(limit, rows.length)),
    cursor: { ...screen.cursor },
  };
}

function capture({ xterm, renderFailed }: ScreenSource, limit: number): ElwoodScreen {
  const buffer = xterm.buffer.active;
  // `baseY` is the first live row. `viewportY` would follow the host's scroll position.
  const firstLiveRow = buffer.baseY;
  const scrollbackCount = Math.min(limit, firstLiveRow);
  return {
    cols: xterm.cols,
    rows: xterm.rows,
    lines: bufferRows(xterm, firstLiveRow, xterm.rows),
    scrollback: bufferRows(xterm, firstLiveRow - scrollbackCount, scrollbackCount),
    cursor: { x: buffer.cursorX, y: buffer.cursorY, visible: parsedCursorVisible(xterm) },
    buffer: buffer.type,
    outputLost: renderFailed,
  };
}

function scrollbackLimit(scrollback: boolean | number = false): number {
  if (typeof scrollback === "boolean") return scrollback ? Number.POSITIVE_INFINITY : 0;
  if (Number.isInteger(scrollback) && scrollback >= 0) return scrollback;
  throw new TypeError("readScreen: scrollback must be a boolean or a non-negative integer.");
}
