/** Confirms physical item movement through modern native picker windows (C-API-23/24). */
import { elwoodError } from "../../errors.ts";
import { arrowDown, arrowUp } from "../../input/constants.ts";
import { sendPickerInput } from "../input.ts";
import { isOwnCompletePicker } from "../own-picker.ts";
import type { ModelPickerIo, ModelPickerSpec } from "../picker.ts";
import type { AgentModelOption, ParsedModelPicker } from "../rows.ts";
import { waitForScreen } from "../tui-screen.ts";
import type { ModelViewport } from "./types.ts";

export type ViewportFrame = ParsedModelPicker & { readonly viewport: ModelViewport };
export type ViewportSpec = Pick<ModelPickerSpec, "agent" | "parse" | "activeDialog">;

export function totalSelectableItemCount(viewport: ModelViewport): number | undefined {
  return viewport.remainingBelow === undefined
    ? undefined
    : viewport.offset + viewport.items.length + viewport.remainingBelow;
}

export function absoluteCursorItemNumber(viewport: ModelViewport): number | undefined {
  return viewport.items[viewport.cursorItemIndex] === undefined
    ? undefined
    : viewport.offset + viewport.cursorItemIndex + 1;
}

/** Every candidate is a complete dialog owned by the operation, including its controls. */
export async function nextViewport(
  io: ModelPickerIo,
  spec: ViewportSpec,
  accepts: (frame: ViewportFrame) => boolean,
  timeoutMs: number,
  label: string,
): Promise<ViewportFrame> {
  let found!: ViewportFrame;
  const owned = isOwnCompletePicker(spec);
  await waitForScreen(
    io.terminal,
    (text) => {
      if (!owned(text)) return false;
      const parsed = spec.parse(text);
      if (parsed.viewport === undefined) return false;
      const frame = { ...parsed, viewport: parsed.viewport };
      if (!accepts(frame)) return false;
      found = frame;
      return true;
    },
    timeoutMs,
    `${spec.agent} picker ${label}`,
    io.signal,
  );
  return found;
}

/** A known end stays fixed while Codex can still hide uncounted rows before it. */
export function compatibleLength(frame: ViewportFrame, expected: number | undefined): boolean {
  if (expected === undefined) return true;
  const length = totalSelectableItemCount(frame.viewport);
  return length === undefined
    ? frame.viewport.offset + frame.viewport.items.length < expected
    : length === expected;
}

/** The source cursor, counted total, and evidence of another item survive a repaint. */
export function viewportSource(
  frame: ViewportFrame,
  cursor: number,
  length: number | undefined,
  direction?: "up" | "down",
): boolean {
  const viewport = frame.viewport;
  return (
    absoluteCursorItemNumber(viewport) === cursor &&
    compatibleLength(frame, length) &&
    (direction !== "down" ||
      viewport.remainingBelow === undefined ||
      cursor < viewport.offset + viewport.items.length + viewport.remainingBelow)
  );
}

/** Metadata may repaint during the received-output barrier; retry only that prewrite refusal. */
export async function sendViewportInput(
  io: ModelPickerIo,
  spec: ViewportSpec,
  input: typeof arrowUp | typeof arrowDown | "\r",
  accepts: (frame: ViewportFrame) => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  const owned = isOwnCompletePicker(spec);
  for (;;) {
    let metadataChanged = false;
    try {
      await sendPickerInput(io, input, (text) => {
        if (!owned(text)) return false;
        const parsed = spec.parse(text);
        const accepted =
          parsed.viewport !== undefined && accepts({ ...parsed, viewport: parsed.viewport });
        metadataChanged = !accepted;
        return accepted;
      });
      return;
    } catch (error) {
      // The flag is set only by a rejected predicate, before sendInput can run.
      if (!metadataChanged) throw error;
    }
    await nextViewport(
      io,
      spec,
      accepts,
      deadline - performance.now(),
      "stable model navigation metadata",
    );
  }
}

/** Moves within the visible target's physical position, crossing disclosures as items. */
export async function moveViewportCursor(
  io: ModelPickerIo,
  spec: ViewportSpec,
  opening: ViewportFrame,
  target: number,
  timeoutMs: number,
  knownItemCount = totalSelectableItemCount(opening.viewport),
): Promise<ViewportFrame> {
  const deadline = performance.now() + timeoutMs;
  let frame = opening;
  const length = knownItemCount;
  for (;;) {
    const cursor = absoluteCursorItemNumber(frame.viewport);
    if (cursor === undefined)
      throw elwoodError("model_automation_failed", "Could not locate the picker cursor.");
    if (cursor === target) return frame;
    const down = target > cursor;
    const expected = cursor + (down ? 1 : -1);
    await sendViewportInput(
      io,
      spec,
      down ? arrowDown : arrowUp,
      (next) => viewportSource(next, cursor, length, down ? "down" : "up"),
      deadline - performance.now(),
    );
    frame = await nextViewport(
      io,
      spec,
      (next) =>
        absoluteCursorItemNumber(next.viewport) === expected && compatibleLength(next, length),
      deadline - performance.now(),
      `cursor on item ${expected}`,
    );
  }
}

/** The requested model is visible; its selectable position includes disclosure rows. */
export function selectViewportModel(
  io: ModelPickerIo,
  spec: ViewportSpec,
  frame: ViewportFrame,
  isTarget: (option: AgentModelOption) => boolean,
  timeoutMs: number,
): Promise<ViewportFrame> {
  const target = frame.viewport.items.findIndex(
    (item) => item.kind === "model" && isTarget(item.row.option),
  );
  return moveViewportCursor(io, spec, frame, frame.viewport.offset + target + 1, timeoutMs);
}
