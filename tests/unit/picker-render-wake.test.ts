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

/**
 * Lists models from a CLI that opens the picker, and closes it on Escape, `paintMs` later.
 * `renders` is whether the terminal reports completed renders: always, never (it cannot
 * subscribe), or silently (it subscribes but never reports one).
 */
async function listing(renders: "reported" | "unsupported" | "silent") {
  const listeners = new Set<() => void>();
  const terminal = scripted(closedComposer(claudeModelPicker));
  const paint = (text: string) =>
    setTimeout(() => {
      terminal.text = text;
      if (renders === "reported") for (const listener of listeners) listener();
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
    ...(renders === "unsupported"
      ? {}
      : {
          subscribeRender: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        }),
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
  // Every wait unsubscribes when it ends.
  return { models, elapsedMs: finishedAt - started, subscribed: listeners.size };
}

test("C-API-23 listModels reads the opening and closing picker on the renders that paint them", async () => {
  const reported = await listing("reported");
  expect(reported.models).toEqual(claudeModelPicker.parse(claudePicker).options);
  // Two repaints, the picker opening and then closing on Escape, and no poll waited out.
  expect(reported.elapsedMs).toBe(2 * paintMs);
  expect(reported.subscribed).toBe(0);
  // A terminal that cannot report renders still polls: one interval per repaint.
  expect((await listing("unsupported")).elapsedMs).toBe(200);
});

test("C-API-23 a picker wait still polls a frame no render reported", async () => {
  const silent = await listing("silent");
  expect(silent.models).toEqual(claudeModelPicker.parse(claudePicker).options);
  expect(silent.elapsedMs).toBe(200);
  expect(silent.subscribed).toBe(0);
});
