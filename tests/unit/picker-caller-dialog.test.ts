/**
 * A dialog the caller owns that replaces ours, Claude's `PreModelSwitch` hook confirmation,
 * is left for the caller: a failed operation's survivor is forgotten on it, even after our
 * own dialog was seen (PRD §5.3, C-API-55).
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import type { ModelDialogAuthority } from "../../src/core/models/rows.ts";
import { claudePickerViewport } from "../helpers/model-dialog-viewports.ts";
import { claudeHookSwitchConfirmation } from "../helpers/model-pickers.ts";
import { cleanupHarness, failure } from "../helpers/picker-harness.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const opened: ModelDialogAuthority = { opened: true };
/**
 * The hook's confirmation cut mid-paint, before its reason is legible: until then it is the
 * shell a cache warning shares, so it is held on as ours and never answered.
 */
const paintingHookShell = "Switch model?\nA PreModelSw";

test("C-API-55 the hook confirmation is positive evidence, and its shell is not", () => {
  expect(claudeModelPicker.activeDialog(paintingHookShell, opened)).toBe("painting");
  expect(claudeModelPicker.isCallerDialog(paintingHookShell)).toBe(false);
  expect(claudeModelPicker.activeDialog(claudeHookSwitchConfirmation, opened)).toBeUndefined();
  expect(claudeModelPicker.isCallerDialog(claudeHookSwitchConfirmation)).toBe(true);
});

test.each([
  ["its complete picker", claudePickerViewport],
  ["the hook's painting shell", paintingHookShell],
])("C-API-55 a hook confirmation that replaced %s holds no input", async (_name, seen) => {
  const { screen, writes, picker } = cleanupHarness(claudeModelPicker);
  const failed = expect(
    picker.run("set_model", claudeModelPicker, 5000, async (io) => {
      await io.submit("/model", new AbortController().signal);
      screen.text = seen;
      io.terminal.snapshot();
      screen.text = claudeHookSwitchConfirmation;
      throw failure;
    }),
  ).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(1100);
  await failed;
  expect(writes).toEqual(["/model"]);
  expect(picker.blocksInput()).toBe(false);
});

/** Cleanup's bound ends while the shell still paints, so the shell is kept as ours. */
test("C-API-55 a survivor is forgotten once the hook confirmation finishes painting", async () => {
  const { screen, writes, picker } = cleanupHarness(claudeModelPicker);
  const failed = expect(
    picker.run("set_model", claudeModelPicker, 5000, async (io) => {
      await io.submit("/model", new AbortController().signal);
      screen.text = paintingHookShell;
      throw failure;
    }),
  ).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(1100);
  await failed;
  expect(picker.blocksInput()).toBe(true);
  screen.text = claudeHookSwitchConfirmation;
  expect(picker.blocksInput()).toBe(false);
  expect(writes).toEqual(["/model"]);
});
