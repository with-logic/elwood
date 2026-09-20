/** Cleanup covers dialogs that paint after the failure; foreign picker text is refused (C-API-55). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import { listPickerModels } from "../../src/core/models/picker.ts";
import { waitForScreen } from "../../src/core/models/tui-screen.ts";
import { codexReasoningViewport } from "../helpers/model-dialog-viewports.ts";
import {
  claudeModelCacheConfirmationOnNo,
  claudePicker,
  codexPickerCurrentIsDefault,
  codexReasoningScreen,
} from "../helpers/model-pickers.ts";
import { escapeKey, pickerHarness, type Screen } from "../helpers/picker-harness.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const never = new AbortController().signal;
/** Real CLIs: Escape on a follow-up stage reopens `pickerText`; Escape on the picker closes it. */
const escapes = (followUp: string, pickerText: string) => (input: string, shown: Screen) => {
  if (input === escapeKey) shown.text = shown.text === followUp ? pickerText : "❯ ";
};

test.each([
  [
    "Codex reasoning level",
    codexModelPicker,
    codexPickerCurrentIsDefault,
    "\r",
    codexReasoningScreen,
  ],
  ["Claude cache warning", claudeModelPicker, claudePicker, "s", claudeModelCacheConfirmationOnNo],
] as const)("C-API-55 a %s painting after the deadline is cancelled before input is released", async (_name, spec, pickerText, applyKey, followUp) => {
  // The apply key blanks the picker; the CLI paints the follow-up stage late.
  const { screen, writes, leaked, queue, picker } = pickerHarness("❯ ", (input, shown) => {
    if (input === applyKey) shown.text = "";
    escapes(followUp, pickerText)(input, shown);
  });
  const failed = expect(
    picker.run("set_model", spec, 50, async (io) => {
      await io.submit("/model", never);
      screen.text = pickerText;
      return spec.apply(io, 5000);
    }),
  ).rejects.toMatchObject({ code: "model_automation_failed" });
  setTimeout(() => {
    screen.text = followUp;
  }, 300);
  await vi.advanceTimersByTimeAsync(350);
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(1000);
  await Promise.all([failed, message]);
  expect(leaked).toEqual([]);
  expect(writes).toEqual(["/model", applyKey, escapeKey, escapeKey]);
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});

test.each([
  ["opens late and is cancelled", 300, ["/model", escapeKey]],
  ["never opens, releasing input at the bound", undefined, ["/model"]],
] as const)("C-API-55 a submitted picker that %s", async (_name, opensAfterMs, expected) => {
  const { screen, writes, leaked, queue, picker } = pickerHarness("❯ ", escapes("", claudePicker));
  const failed = expect(
    picker.run("list_models", claudeModelPicker, 50, (io) =>
      listPickerModels(io, claudeModelPicker, 5000),
    ),
  ).rejects.toMatchObject({ code: "model_automation_failed" });
  // The CLI acts on the already-submitted command only after the operation timed out.
  if (opensAfterMs !== undefined)
    setTimeout(() => {
      screen.text = claudePicker;
    }, opensAfterMs);
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(1200);
  await Promise.all([failed, message]);
  expect(leaked).toEqual([]);
  expect(writes).toEqual(expected);
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});

test("C-API-55 a picker reopening after a clear frame receives its own Escape", async () => {
  const { screen, writes, queue, picker } = pickerHarness("❯ ", escapes("", claudePicker));
  const failure = new Error("navigation failed");
  const failed = expect(
    picker.run("set_model", claudeModelPicker, 5000, async (io) => {
      await io.submit("/model", never);
      screen.text = claudePicker;
      await io.terminal.sendInput("s");
      await io.terminal.sendInput(escapeKey);
      throw failure;
    }),
  ).rejects.toBe(failure);
  // A re-submitted `/model` the CLI had buffered opens the picker again.
  setTimeout(() => {
    screen.text = claudePicker;
  }, 300);
  await vi.advanceTimersByTimeAsync(1200);
  await failed;
  expect(writes).toEqual(["/model", "s", escapeKey, escapeKey]);
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});

test("C-API-55 terminating while awaiting a late dialog prevents the cleanup Escape", async () => {
  const { screen, writes, queue, picker } = pickerHarness("❯ ", () => {});
  const failed = picker
    .run("set_model", claudeModelPicker, 50, async (io) => {
      await io.submit("/model", never);
      await waitForScreen(io.terminal, claudeModelPicker.isOpen, 5000, "picker");
    })
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(200);
  queue.close();
  screen.text = claudePicker;
  await vi.advanceTimersByTimeAsync(1500);
  expect(await failed).toBeInstanceOf(Error);
  expect(writes).toEqual(["/model"]);
});

test.each([
  ["a transcript quoting a picker", claudeModelPicker, `${claudePicker}\n\n❯ `],
  ["a human's reasoning-level dialog", codexModelPicker, codexReasoningViewport],
] as const)("C-API-55 %s already on screen is never driven, cancelled, or held on", async (_name, spec, text) => {
  const { writes, queue, picker } = pickerHarness(text, () => {});
  const failed = expect(
    picker.run("list_models", spec, 300, (io) => listPickerModels(io, spec, 300)),
  ).rejects.toMatchObject({
    code: "model_automation_failed",
    message: expect.stringContaining("already visible"),
  });
  await vi.advanceTimersByTimeAsync(1500);
  await failed;
  expect(writes).toEqual([]);
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});
