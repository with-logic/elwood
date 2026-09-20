/** A recognized foreign picker stays held through ambiguous redraws (C-API-55). */
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../src/codex/model-picker.ts";
import { codexPickerCurrentIsDefault } from "../helpers/model-pickers.ts";
import { pickerHarness } from "../helpers/picker-harness.ts";

test("C-API-55 a foreign picker remains held through missing rows and blank frames", () => {
  const { picker, screen, queue } = pickerHarness(
    codexPickerCurrentIsDefault,
    () => {},
    codexModelPicker,
  );
  expect(picker.foreignDialogVisible()).toBe(true);
  for (const repaint of ["Select Model and Effort", "", "›", "› 1. gpt-5.5"]) {
    screen.text = repaint;
    for (let read = 0; read < 6; read += 1) expect(picker.foreignDialogVisible()).toBe(true);
  }
  screen.text = "› Ask Codex to do anything\n  gpt-5.5 high";
  for (let read = 0; read < 4; read += 1) expect(picker.foreignDialogVisible()).toBe(true);
  expect(picker.foreignDialogVisible()).toBe(false);
  queue.close();
});

test("C-API-55 a first partial picker frame holds input before its rows finish", () => {
  const { picker, screen, queue } = pickerHarness(
    "Select Model and Effort\n› 1. gpt-5.5",
    () => {},
    codexModelPicker,
  );
  expect(picker.foreignDialogVisible()).toBe(true);
  screen.text = "";
  expect(picker.foreignDialogVisible()).toBe(true);
  queue.close();
});

test.each([
  [
    claudeModelPicker,
    "Select model\n❯ 1. Sonnet  Default\n  2. Haiku  Fast\nEsc to cancel\n❯ user draft",
  ],
  [
    codexModelPicker,
    "Select Model and Effort\n› 1. gpt-5.5  Default\n  2. gpt-5.4  Fast\nEsc to cancel\n› user draft",
  ],
])("C-API-55 quoted $agent picker rows above a composer do not start a hold", (spec, quote) => {
  const { picker, queue } = pickerHarness(quote, () => {}, spec);
  expect(picker.foreignDialogVisible()).toBe(false);
  queue.close();
});
