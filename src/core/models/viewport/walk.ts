/** Enumerates modern model windows and expands non-model disclosures (C-API-23/24). */
import { elwoodError } from "../../errors.ts";
import { inPickerOrder } from "../model-row.ts";
import type { ModelPickerIo } from "../picker.ts";
import type { PickerRow } from "../rows.ts";
import type { PickerWalk, RevealedPicker } from "../window.ts";
import {
  absoluteCursorItemNumber,
  moveViewportCursor,
  nextViewport,
  sendViewportInput,
  totalSelectableItemCount,
  type ViewportFrame,
  type ViewportSpec,
  viewportSource,
} from "./move.ts";

/**
 * Walks both physical ends and expands collapsed disclosures to return every model in
 * native row order. Disclosures occupy selectable positions but never become options.
 * A `found` predicate stops as soon as its matching model is visible, before a full walk.
 */
export async function revealViewportRows(
  io: ModelPickerIo,
  spec: ViewportSpec,
  opening: ViewportFrame,
  walk: PickerWalk,
): Promise<RevealedPicker> {
  const deadline = performance.now() + walk.timeoutMs;
  const rows = new Map<number, PickerRow>();
  const positions = new Set<number>();
  let frame = opening;
  let length = totalSelectableItemCount(frame.viewport);
  const revealed = () => ({
    frame,
    options: inPickerOrder(rows),
  });
  for (;;) {
    const viewport = frame.viewport;
    viewport.items.forEach((item, index) => {
      positions.add(viewport.offset + index + 1);
      if (item.kind === "model" && !rows.has(item.row.absoluteRowNumber))
        rows.set(item.row.absoluteRowNumber, item.row);
    });
    if (walk.found !== undefined && frame.options.some(walk.found)) return revealed();
    const collapsed = viewport.items.findIndex(
      (item) => item.kind === "disclosure" && !item.expanded,
    );
    if (collapsed >= 0) {
      const disclosurePosition = viewport.offset + collapsed + 1;
      frame = await moveViewportCursor(
        io,
        spec,
        frame,
        disclosurePosition,
        deadline - performance.now(),
      );
      await sendViewportInput(
        io,
        spec,
        "\r",
        (next) =>
          selectedDisclosure(next, false) && viewportSource(next, disclosurePosition, length),
        deadline - performance.now(),
      );
      frame = await nextViewport(
        io,
        spec,
        (next) => {
          const item = next.viewport.items[next.viewport.cursorItemIndex];
          return item?.kind === "disclosure" && item.expanded;
        },
        deadline - performance.now(),
        "expanded model disclosure",
      );
      rows.clear();
      positions.clear();
      length = totalSelectableItemCount(frame.viewport);
      continue;
    }
    if (length !== undefined && positions.size === length) return revealed();
    const cursor = absoluteCursorItemNumber(viewport);
    if (cursor === undefined)
      throw elwoodError("model_automation_failed", "Could not locate the picker cursor.");
    const down = length === undefined || !positions.has(length);
    const expected = cursor + (down ? 1 : -1);
    frame = await moveViewportCursor(
      io,
      spec,
      frame,
      expected,
      deadline - performance.now(),
      length,
    );
    length ??= totalSelectableItemCount(frame.viewport);
  }
}

function selectedDisclosure(frame: ViewportFrame, expanded: boolean): boolean {
  const viewport = frame.viewport;
  const item = viewport.items[viewport.cursorItemIndex];
  return item?.kind === "disclosure" && item.expanded === expanded;
}
