/** A partially painted Claude switch dialog is still a dialog (PRD §5.3, C-API-24, C-API-55). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { setPickerModel } from "../../src/core/models/picker.ts";
import {
  claudeCacheWarningPartialViewport,
  claudeCacheWarningViewport,
  claudeClosedPickerViewport,
  claudePickerViewport,
} from "../helpers/model-dialog-viewports.ts";
import { escapeKey, pickerHarness } from "../helpers/picker-harness.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("C-API-55 a surviving cache warning stays held through a partial repaint", async () => {
  const { screen, queue, picker } = pickerHarness(claudeClosedPickerViewport, () => {});
  const failure = new Error("navigation failed");
  const failed = expect(
    picker.run("set_model", claudeModelPicker, 5000, () => {
      screen.text = claudeCacheWarningViewport;
      return Promise.reject(failure);
    }),
  ).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(1100);
  await failed;
  expect(picker.blocksInput()).toBe(true);
  // Claude repaints the dialog; one frame has its title and copy but no options yet.
  screen.text = claudeCacheWarningPartialViewport;
  expect(picker.blocksInput()).toBe(true);
  screen.text = claudeCacheWarningViewport;
  expect(picker.blocksInput()).toBe(true);
  screen.text = claudeClosedPickerViewport;
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});

test("C-API-24 setModel does not settle on the partial frame that precedes the cache warning", async () => {
  // A reply quoted a bare composer caret, so an idle-looking row is always in the viewport.
  const quotedCaret = "⏺ The prompt row looks like this:\n❯\n\n";
  const { writes, leaked, queue, picker } = pickerHarness(
    claudeClosedPickerViewport,
    (input, screen) => {
      if (input === "/model") screen.text = quotedCaret + claudePickerViewport;
      if (input === "s") {
        screen.text = quotedCaret + claudeCacheWarningPartialViewport;
        setTimeout(() => {
          screen.text = quotedCaret + claudeCacheWarningViewport;
        }, 150);
      }
      if (input === "\r") screen.text = claudeClosedPickerViewport;
    },
  );
  // The cursor already rests on the target row, so apply is the first key written.
  const setting = picker.run("set_model", claudeModelPicker, 5000, (io) =>
    setPickerModel(io, claudeModelPicker, "opus (1m context)", 5000),
  );
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(1000);
  await Promise.all([setting, message]);
  expect(leaked).toEqual([]);
  expect(writes).toEqual(["/model", "s", "\r"]);
  expect(writes).not.toContain(escapeKey);
  queue.close();
});

test("C-API-55 a painting switch dialog is not written to until it is complete", async () => {
  // Real Claude 2.1.274: Escape on the warning reopens the picker; Escape there closes it.
  const shownAtWrite: string[] = [];
  const { screen, writes, queue, picker } = pickerHarness("❯ ", (_input, shown) => {
    shownAtWrite.push(shown.text);
    shown.text = shown.text === claudeCacheWarningViewport ? claudePickerViewport : "❯ ";
  });
  const failure = new Error("navigation failed");
  const failed = expect(
    picker.run("set_model", claudeModelPicker, 5000, () => {
      screen.text = claudeCacheWarningPartialViewport;
      return Promise.reject(failure);
    }),
  ).rejects.toBe(failure);
  setTimeout(() => {
    screen.text = claudeCacheWarningViewport;
  }, 250);
  await vi.advanceTimersByTimeAsync(1200);
  await failed;
  expect(writes).toEqual([escapeKey, escapeKey]);
  expect(shownAtWrite).toEqual([claudeCacheWarningViewport, claudePickerViewport]);
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});
