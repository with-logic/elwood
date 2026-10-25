/**
 * Picker waits read each frame on the render that paints it, not on the next 100 ms poll
 * (PRD §5.3, C-API-23).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { ControlQueue } from "../../src/core/control-queue/index.ts";
import { listPickerModels } from "../../src/core/models/picker.ts";
import { PickerTransactions } from "../../src/runtime/session/picker.ts";
import { claudePicker } from "../helpers/model-pickers.ts";
import { closedComposer, escapeKey } from "../helpers/picker-harness.ts";
import { scripted } from "./scripted-terminal.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** How long the fake CLI takes to repaint after a write. */
const paintMs = 5;

/** Lists models from a CLI that opens the picker, and closes it on Escape, `paintMs` later. */
async function listing(observed: boolean) {
  const renders: (() => void)[] = [];
  const terminal = scripted(closedComposer(claudeModelPicker));
  const paint = (text: string) =>
    setTimeout(() => {
      terminal.text = text;
      for (const render of renders) render();
    }, paintMs);
  terminal.onInput = (input) => {
    if (input === "/model") paint(claudePicker);
    else if (input === escapeKey) paint(closedComposer(claudeModelPicker));
  };
  const queue = new ControlQueue(
    () => Promise.resolve(),
    () => new Error("closed"),
    () => {},
  );
  const picker = new PickerTransactions({
    terminal,
    controlQueue: queue,
    blocked: () => false,
    picker: () => claudeModelPicker,
    submitDirect: (command) => Promise.resolve(terminal.sendInput(command)),
    ...(observed ? { observeRendered: (listener) => renders.push(() => listener()) } : {}),
  });
  queue.markReady();
  const started = Date.now();
  let finishedAt = Number.POSITIVE_INFINITY;
  const listed = picker.run("list_models", claudeModelPicker, 5_000, async (io) => {
    const models = await listPickerModels(io, claudeModelPicker, 5_000);
    finishedAt = Date.now();
    return models;
  });
  await vi.advanceTimersByTimeAsync(1_000);
  const models = await listed;
  queue.close();
  return { models, elapsedMs: finishedAt - started };
}

test("C-API-23 listModels reads the opening and closing picker on the renders that paint them", async () => {
  const observed = await listing(true);
  expect(observed.models).toEqual(claudeModelPicker.parse(claudePicker).options);
  // Two repaints, the picker opening and then closing on Escape, and no poll waited out.
  expect(observed.elapsedMs).toBe(2 * paintMs);
  // A terminal that cannot report renders still polls: one interval per repaint.
  expect((await listing(false)).elapsedMs).toBe(200);
});
