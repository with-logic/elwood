/**
 * Every picker key is decided on everything RECEIVED, not the last rendered frame: a prompt
 * already in the PTY buffer while the snapshot still shows the picker never gets the key,
 * and a screen that cannot be vouched for gets none (PRD §5.3, C-API-24, C-API-56).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { setPickerModel } from "../../src/core/models/picker.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { claudePicker } from "../helpers/model-pickers.ts";
import { type Barrier, closedComposer, pickerHarness } from "../helpers/picker-harness.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A real AskUserQuestion prompt (2.1.310): `↓` on it would move its selection to Option B. */
const question = capturedFrame("claude-2.1.310/questions/single-question");

/** `setModel("sonnet")`: one `↓` from the picker's cursor on row 3, then `s`. */
async function switchToSonnet(barrier: Barrier, deliver?: (shown: { text: string }) => void) {
  const { writes, queue, picker } = pickerHarness(
    closedComposer(claudeModelPicker),
    (input, shown) => {
      if (input !== "/model") return;
      shown.text = claudePicker;
      deliver?.(shown);
    },
    claudeModelPicker,
    barrier,
  );
  const switched = picker.run("set_model", claudeModelPicker, 5_000, (io) =>
    setPickerModel(io, claudeModelPicker, "sonnet", 5_000),
  );
  const outcome = switched.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(10_000);
  queue.close();
  return { error: await outcome, writes };
}

test("C-API-56 setModel withholds its arrow from a prompt received but not yet rendered", async () => {
  // The question reaches the PTY right after the picker paints; only `settled()` renders it.
  let pending: (() => void) | undefined;
  const { error, writes } = await switchToSonnet(
    {
      settled: () => {
        pending?.();
        pending = undefined;
        return Promise.resolve();
      },
    },
    (shown) => {
      pending = () => {
        shown.text = question;
      };
    },
  );
  expect(error).toMatchObject({
    code: "model_automation_failed",
    message: "The model picker was replaced before input could be sent.",
  });
  // Only `/model`: no arrow reached the question, and nothing of ours was left to cancel.
  expect(writes).toEqual(["/model"]);
});

test("C-API-56 setModel sends no key once a render fails after the picker opened", async () => {
  // Healthy when the operation starts; the barrier must be read live, not copied once.
  const barrier = { renderFailed: false };
  const { error, writes } = await switchToSonnet(barrier, () => {
    barrier.renderFailed = true;
  });
  expect(error).toMatchObject({
    code: "model_automation_failed",
    message: "The model picker screen could not be verified before input could be sent.",
  });
  // Cleanup's Escape is withheld for the same reason, so nothing follows `/model`.
  expect(writes).toEqual(["/model"]);
});
