/** Enumerates modern model windows and expands non-model disclosures (C-API-23/24). */
import { elwoodError } from "../../errors.ts";
import { arrowDown, arrowUp } from "../../input/constants.ts";
import { inPickerOrder } from "../model-row.ts";
import type { ModelPickerIo } from "../picker.ts";
import type { PickerRow } from "../rows.ts";
import type { PickerWalk, RevealedPicker } from "../window.ts";
import {
  compatibleLength,
  moveViewportCursor,
  nextViewport,
  sendViewportInput,
  type ViewportFrame,
  type ViewportSpec,
  viewportCursor,
  viewportLength,
  viewportSource,
} from "./move.ts";

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
  let length = viewportLength(frame.viewport);
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
      length = viewportLength(frame.viewport);
      continue;
    }
    if (length !== undefined && positions.size === length) return revealed();
    const cursor = viewportCursor(viewport);
    if (cursor === undefined)
      throw elwoodError("model_automation_failed", "Could not locate the picker cursor.");
    const down = length === undefined || !positions.has(length);
    const expected = cursor + (down ? 1 : -1);
    await sendViewportInput(
      io,
      spec,
      down ? arrowDown : arrowUp,
      (next) => viewportSource(next, cursor, length, down ? "down" : "up"),
      deadline - performance.now(),
    );
    const expectedLength = length;
    frame = await nextViewport(
      io,
      spec,
      (next) =>
        viewportCursor(next.viewport) === expected && compatibleLength(next, expectedLength),
      deadline - performance.now(),
      `cursor on item ${expected}`,
    );
    length ??= viewportLength(frame.viewport);
  }
}

function selectedDisclosure(frame: ViewportFrame, expanded: boolean): boolean {
  const viewport = frame.viewport;
  const item = viewport.items[viewport.cursorItemIndex];
  return item?.kind === "disclosure" && item.expanded === expanded;
}
