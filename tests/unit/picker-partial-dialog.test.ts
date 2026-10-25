/** A partially painted Claude switch dialog is still a dialog (PRD §5.3, C-API-24, C-API-55). */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { listPickerModels, setPickerModel } from "../../src/core/models/picker.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import {
  claudeCacheWarningPartialViewport,
  claudeCacheWarningViewport,
  claudeClosedPickerViewport,
  claudePickerViewport,
} from "../helpers/model-dialog-viewports.ts";
import {
  escapeKey,
  guardedPickerHarness,
  pickerHarness,
  releasesAfterClearStreak,
} from "../helpers/picker-harness.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("C-API-55 a surviving cache warning stays held through a partial repaint", async () => {
  const { screen, queue, picker } = pickerHarness(claudeClosedPickerViewport, () => {});
  const failure = new Error("navigation failed");
  const failed = expect(
    picker.run("set_model", claudeModelPicker, 5000, async (io) => {
      await io.submit("/model", new AbortController().signal);
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
  // A stable run of clear frames releases it; one frame could be another repaint.
  expect(releasesAfterClearStreak(() => picker.blocksInput())).toBe(true);
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
    picker.run("set_model", claudeModelPicker, 5000, async (io) => {
      await io.submit("/model", new AbortController().signal);
      screen.text = claudeCacheWarningPartialViewport;
      return Promise.reject(failure);
    }),
  ).rejects.toBe(failure);
  setTimeout(() => {
    screen.text = claudeCacheWarningViewport;
  }, 250);
  await vi.advanceTimersByTimeAsync(1200);
  await failed;
  expect(writes).toEqual(["/model", escapeKey, escapeKey]);
  expect(shownAtWrite).toEqual(["❯ ", claudeCacheWarningViewport, claudePickerViewport]);
  // The picker reopened by the last Escape is gone, so nothing survived cleanup.
  expect(picker.blocksInput()).toBe(false);
  queue.close();
});

/** Claude never finishes painting the picker: its header sits over stale slash commands. */
function timedOutListing(partial: string) {
  const harness = guardedPickerHarness(claudeClosedPickerViewport, (input, shown) => {
    if (input === "/model") shown.text = partial;
  });
  const failed = harness.picker
    .run("list_models", claudeModelPicker, 50, (io) =>
      listPickerModels(io, claudeModelPicker, 5000),
    )
    .catch((error: unknown) => error);
  return { ...harness, failed };
}

test("C-API-55 a listing that times out on a half-painted picker holds a queued message until the composer clears", async () => {
  const partial = capturedFrame("claude-2.1.310/model-picker/painting-three-rows");
  const { screen, writes, queue, failed, delivered } = timedOutListing(partial);
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(1200);
  expect(await failed).toMatchObject({ code: "model_automation_failed" });
  // Nothing recognizable was ever on screen, so nothing but the command was written...
  expect(writes).toEqual(["/model"]);
  // ...yet a picker is still up, and Enter on it would apply its highlighted row, so the
  // queued message waits however long the picker stays half-painted.
  await vi.advanceTimersByTimeAsync(10_000);
  expect(delivered("hello")).toBe(0);
  screen.text = claudeClosedPickerViewport;
  await vi.advanceTimersByTimeAsync(1000);
  await message;
  expect(delivered("hello")).toBe(1);
  queue.close();
});

test("C-API-55 a picker header quoted above a clear composer holds nothing after cleanup", async () => {
  const quoted = `⏺ The dialog title reads "Select model".\n\n${claudeClosedPickerViewport}`;
  const { writes, queue, picker, failed, delivered } = timedOutListing(quoted);
  await vi.advanceTimersByTimeAsync(1200);
  expect(await failed).toMatchObject({ code: "model_automation_failed" });
  expect(writes).toEqual(["/model"]);
  expect(picker.blocksInput()).toBe(false);
  const message = queue.send("hello", "message");
  await vi.advanceTimersByTimeAsync(1000);
  await message;
  expect(delivered("hello")).toBe(1);
  queue.close();
});

test("C-API-24 no key is written to the operation's own dialog while it is still painting", async () => {
  const arrowDown = "\u001b[B";
  const { writes, queue, picker } = pickerHarness(claudeClosedPickerViewport, (input, screen) => {
    if (input === "/model") screen.text = claudePickerViewport;
    // The first step repaints the dialog: a frame with its title and copy but no options.
    if (input === arrowDown) screen.text = claudeCacheWarningPartialViewport;
  });
  const setting = expect(
    picker.run("set_model", claudeModelPicker, 5000, (io) =>
      setPickerModel(io, claudeModelPicker, "sonnet", 5000),
    ),
  ).rejects.toMatchObject({ code: "model_automation_failed" });
  // Past the cursor-settle wait, so a key written into the painting frame fails here.
  await vi.advanceTimersByTimeAsync(7000);
  await setting;
  // Sonnet is two rows down, but the second step would land in a dialog with no options.
  expect(writes).toEqual(["/model", arrowDown]);
  queue.close();
});
