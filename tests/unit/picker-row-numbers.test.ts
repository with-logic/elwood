/**
 * Each parsed picker row keeps the absolute number the CLI drew, and a Claude window's
 * overflow line says how many rows it hides below, read only where the grammar allows that
 * line (PRD §5.3, C-API-23).
 */
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { ownOperation, parseCodexModelPicker } from "../../src/core/models/rows.ts";
import { capturedFrame } from "../helpers/captured-frames.ts";
import { codexPickerViewport } from "../helpers/model-dialog-viewports.ts";

/** A real Claude 2.1.310 frame (2026-10-24): header to viewport bottom, 13 models. */
const frame = (name: string) => capturedFrame(`claude-2.1.310/model-picker/${name}`);

const numbers = (text: string) =>
  claudeModelPicker.parse(text).rows.map((row) => row.absoluteRowNumber);
const hidden = (text: string) => claudeModelPicker.parse(text).hiddenRowCountBelow;
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

test.each([
  ["top-window", 1, 10, 3],
  ["cursor-on-down-marker", 1, 10, 3],
  ["both-markers", 3, 12, 1],
  ["opened-on-hidden-current", 3, 12, 1],
  ["bottom-of-list", 4, 13, 0],
] as const)("C-API-23 the captured %s window numbers rows %i to %i and hides %i below", (name, from, to, below) => {
  const parsed = claudeModelPicker.parse(frame(name));
  expect(numbers(frame(name))).toEqual(range(from, to));
  expect(parsed.options).toEqual(parsed.rows.map((row) => row.option));
  expect(parsed.hiddenRowCountBelow).toBe(below);
});

test("C-API-23 a Codex list numbers its rows and hides none", () => {
  const parsed = parseCodexModelPicker(codexPickerViewport);
  expect(parsed.rows.map((row) => row.absoluteRowNumber)).toEqual([1, 2, 3, 4, 5]);
  expect(parsed.hiddenRowCountBelow).toBe(0);
});

test.each([
  ["a `↓` row without the count under it", "     … +3 models\n", ""],
  ["a zero count", "… +3 models", "… +0 models"],
  ["a count past exact integers", "… +3 models", "… +99999999999999999999 models"],
  ["a count under a row that is neither `↓` nor the cursor", "  ↓ 10.", "    10."],
])("C-API-23 a window with %s hides an unknown number of rows", (_name, drawn, forged) => {
  const text = frame("top-window").replace(drawn, forged);
  expect(text).not.toBe(frame("top-window"));
  expect(hidden(text)).toBeUndefined();
});

test("C-API-24 a row number past exact integers is neither a picker row nor a parsed one", () => {
  // 9007199254740993 rounds to 9007199254740992; 400 nines round to Infinity, so every row
  // would carry the same number and still pass for consecutive.
  const rounded = frame("both-markers").replace("↑ 3.", "↑ 9007199254740993.");
  const huge = frame("both-markers").replace(/(\s)\d+\.(\s)/g, `$1${"9".repeat(400)}.$2`);
  expect(rounded).not.toBe(frame("both-markers"));
  expect(huge).not.toMatch(/\s\d{1,2}\.\s/);
  for (const text of [rounded, huge])
    expect(claudeModelPicker.activeDialog(text, ownOperation)).toBeUndefined();
  expect(numbers(rounded)).toEqual(range(4, 12));
  expect(numbers(huge)).toEqual([]);
});
