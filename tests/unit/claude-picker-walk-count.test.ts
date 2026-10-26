/**
 * A Claude picker window's implied list length (its highest rendered row plus the `… +K models`
 * count) is validated, not trusted: a frame whose implied length is missing or differs from
 * the first one read is never acted on, and one deadline bounds the whole walk
 * (PRD §5.3, C-API-23).
 */
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../src/claude/model-picker.ts";
import { listPickerModels } from "../../src/core/models/picker.ts";
import { parseWalk } from "../helpers/captured-frames.ts";
import {
  catalog,
  down,
  escapeKey,
  fromTop,
  io,
  replay,
  topWindow,
} from "./claude-picker-walk-replay.ts";
import { scripted } from "./scripted-terminal.ts";

test.each([
  // Every count the parser cannot vouch for is covered in picker-row-numbers.test.ts.
  ["a `↓` row without the count under it", "     … +3 models\n", ""],
  ["a length past exact integers", "… +3 models", "… +9007199254740990 models"],
])("C-API-23 a window with %s is never walked", async (_name, rendered, forged) => {
  const frame = topWindow.replace(rendered, forged);
  expect(frame).not.toBe(topWindow);
  const terminal = scripted(frame);
  await expect(listPickerModels(io(terminal), claudeModelPicker, 300)).rejects.toMatchObject({
    code: "model_automation_failed",
    message: "Timed out waiting for claude picker row count.",
  });
  expect(terminal.inputs).toEqual([]);
});

test("C-API-23 a window opened before its count is painted is walked once it is", async () => {
  const early = fromTop.opening.replace("     … +3 models\n", "");
  expect(early).not.toBe(fromTop.opening);
  const terminal = replay({ ...fromTop, opening: early });
  setTimeout(() => {
    terminal.text = fromTop.opening;
  }, 150);
  const listed = await listPickerModels(io(terminal), claudeModelPicker, 5_000);
  expect(listed.map((model) => model.id)).toEqual(catalog);
});

test("C-API-23 a moved window whose implied list length differs is never acted on", async () => {
  const [first, ...rest] = fromTop.steps;
  const changed = { ...first, frame: first?.frame.replace("… +3 models", "… +5 models") ?? "" };
  expect(changed.frame).not.toBe(first?.frame);
  const terminal = replay({ ...fromTop, steps: [{ key: down, ...changed }, ...rest] });
  await expect(listPickerModels(io(terminal), claudeModelPicker, 300)).rejects.toMatchObject({
    code: "model_automation_failed",
    message: "Timed out waiting for claude picker cursor on row 2 of 13.",
  });
  expect(terminal.inputs).toEqual([down]);
});

test("C-API-23 a huge rendered count costs only the walk's deadline", async () => {
  // 2^32 rows: sizing anything by it would throw RangeError before a single key.
  const terminal = scripted(topWindow.replace("… +3 models", "… +4294967296 models"));
  await expect(listPickerModels(io(terminal), claudeModelPicker, 300)).rejects.toMatchObject({
    code: "model_automation_failed",
    message: "Timed out waiting for claude picker cursor on row 2 of 4294967306.",
  });
  expect(terminal.inputs).toEqual([down]);
});

test("C-API-23 one deadline bounds the whole walk, not each step", async () => {
  // Every step lands well inside the timeout, but twelve of them do not.
  const terminal = replay(fromTop);
  const paint = terminal.onInput;
  terminal.onInput = (input) => void setTimeout(() => paint?.(input), 250);
  await expect(listPickerModels(io(terminal), claudeModelPicker, 1_000)).rejects.toMatchObject({
    code: "model_automation_failed",
    message: expect.stringMatching(
      /^Timed out waiting for claude picker cursor on row \d+ of 13\.$/,
    ),
  });
  expect(terminal.inputs.length).toBeLessThan(12);
  expect(terminal.inputs).not.toContain(escapeKey);
});

test("captured walks reject a separator that names no key", () => {
  expect(parseWalk("opening\n--- ↓\nnext\n").steps).toEqual([{ key: down, frame: "next\n" }]);
  expect(() => parseWalk("opening\n--- →\nnext\n")).toThrow('Unknown walk marker "→".');
});
