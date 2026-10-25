/**
 * Reads the rows a model picker hides outside its scrolling window.
 * Implements PRD §5.3 (`listModels` returns every listed row; `setModel` selects any),
 * C-API-23, and C-API-24.
 */

import { elwoodError } from "../errors.ts";
import { arrowDown, arrowUp } from "../input/constants.ts";
import { sendPickerInput } from "./input.ts";
import { isOwnCompletePicker } from "./own-picker.ts";
import type { ModelPickerIo, ModelPickerSpec } from "./picker.ts";
import type { AgentModelOption, ParsedModelPicker, PickerRow } from "./rows.ts";
import { waitForScreen } from "./tui-screen.ts";

export type PickerWalk = {
  /** One deadline for the whole walk, however many rows the picker claims. */
  readonly timeoutMs: number;
  /** Stop once a rendered option matches: `setModel` needs its target on screen, no more. */
  readonly found?: (option: AgentModelOption) => boolean;
};

export type RevealedPicker = {
  /** The frame the walk ended on: the cursor and the window it is rendering now. */
  readonly frame: ParsedModelPicker;
  /** Every row seen on the way, in picker order. */
  readonly options: readonly AgentModelOption[];
};

/**
 * Walks the cursor until every row the list holds has been rendered, or `found` matches one.
 * Claude 2.1.310 renders at most ten rows of a longer list. Rows keep their absolute numbers,
 * so a window starting past row 1 hides the rows above it, and the overflow line under its
 * last row counts those below. The window follows the cursor, so the walk moves it one row
 * at a time toward rows not yet seen, below first and then above, and waits for each move
 * to land before the next key, reading it on the render that paints it. It never sends a
 * key past either end of the list, where the CLI wraps: it moves down only while the list's
 * last row is unseen, so the cursor is above it, and up only while the first is. The
 * windows seen are contiguous (each contains the row next to the previous cursor), so the
 * list is complete once it holds as many rows as the list's length. Arrow keys only move
 * the highlight; what follows the walk is the caller's: a listing cancels with Escape,
 * which keeps model and effort, and a selection moves to its target and applies it. A list
 * that fits its window costs no key, which is every Codex list, since Codex's grammar
 * rejects a scrolled one.
 *
 * The rendered count and row numbers are validated, not trusted, whenever the walk still
 * needs rows (a listing, or `setModel` before its target is rendered). The list's length is
 * read from the first frame that states one; a frame that marks rows hidden below without
 * a positive count, has a row number or length that is not an exact integer, or states a
 * different length is never acted on, so the walk times out if no other frame renders.
 * Only rows actually rendered are stored.
 */
export async function revealPickerRows(
  io: ModelPickerIo,
  spec: Pick<ModelPickerSpec, "agent" | "parse" | "activeDialog">,
  opening: ParsedModelPicker,
  walk: PickerWalk,
): Promise<RevealedPicker> {
  const deadline = performance.now() + walk.timeoutMs;
  const ownCompletePicker = isOwnCompletePicker(spec);
  const seen = new Map<number, PickerRow>();
  /**
   * The first frame of the own complete picker that `usable` accepts. Claude repaints a
   * scrolled window across more than one render, so a frame read on one of them can show
   * the new rows above a stale count, or before the count is painted: such a frame is
   * waited out, and fails the walk only if no usable one renders by its deadline.
   */
  const next = async (usable: (frame: ParsedModelPicker) => boolean, label: string) =>
    spec.parse(
      await waitForScreen(
        io.terminal,
        (screen) => ownCompletePicker(screen) && usable(spec.parse(screen)),
        deadline - performance.now(),
        `${spec.agent} picker ${label}`,
        io.signal,
      ),
    );
  let frame = opening;
  let length = listLength(opening);
  for (;;) {
    for (const row of frame.rows)
      if (!seen.has(row.absoluteRowNumber)) seen.set(row.absoluteRowNumber, row);
    if (walk.found !== undefined && frame.options.some(walk.found)) return revealed(frame, seen);
    if (length === undefined) {
      frame = await next((counted) => listLength(counted) !== undefined, "row count");
      length = listLength(frame);
      continue;
    }
    if (seen.size === length) return revealed(frame, seen);
    const cursor = frame.rows[frame.cursorOptionIndex];
    if (cursor === undefined) throw walkFailed("Could not locate the picker cursor.", seen);
    const down = !seen.has(length);
    const row = cursor.absoluteRowNumber + (down ? 1 : -1);
    await sendPickerInput(io, down ? arrowDown : arrowUp, ownCompletePicker);
    const listed = length;
    frame = await next(
      (moved) => cursorRowNumber(moved) === row && listLength(moved) === listed,
      `cursor on row ${row} of ${listed}`,
    );
  }
}

/**
 * The list's length by `frame`'s own account, its highest rendered row plus those hidden, or
 * undefined when the frame cannot say: no valid count, or a sum that is not an exactly
 * representable integer. The grammar already refuses row numbers that round.
 */
function listLength(frame: ParsedModelPicker): number | undefined {
  if (frame.hiddenRowCountBelow === undefined) return undefined;
  const length =
    Math.max(0, ...frame.rows.map((row) => row.absoluteRowNumber)) + frame.hiddenRowCountBelow;
  return Number.isSafeInteger(length) ? length : undefined;
}

/** The highlighted option, or undefined while no cursor is painted. */
export function cursorOption(parsed: ParsedModelPicker): AgentModelOption | undefined {
  return parsed.options[parsed.cursorOptionIndex];
}

function cursorRowNumber(parsed: ParsedModelPicker): number | undefined {
  return parsed.rows[parsed.cursorOptionIndex]?.absoluteRowNumber;
}

function inPickerOrder(seen: ReadonlyMap<number, PickerRow>): AgentModelOption[] {
  return [...seen.values()]
    .sort((left, right) => left.absoluteRowNumber - right.absoluteRowNumber)
    .map((row) => row.option);
}

function revealed(frame: ParsedModelPicker, seen: ReadonlyMap<number, PickerRow>): RevealedPicker {
  return { frame, options: inPickerOrder(seen) };
}

function walkFailed(reason: string, seen: ReadonlyMap<number, PickerRow>): Error {
  return elwoodError("model_automation_failed", reason, {
    available: inPickerOrder(seen).map((option) => option.id),
  });
}
