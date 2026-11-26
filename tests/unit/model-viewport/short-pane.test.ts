/**
 * Claude 2.1.332 sizes its model window to the pane. Below about 22 rows a window holds
 * one model row, or one row beside the `More models` disclosure, and a counted scroll
 * marker vouches for the rows it hides (PRD §5.3, C-API-23, C-API-24).
 */
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../../src/claude/model-picker.ts";
import { capturedFrame } from "../../helpers/captured-frames.ts";

const frame = (name: string) => capturedFrame(`claude-2.1.332/model-picker/${name}`);

test.each([
  ["the opening window at 100x12", "one-row", { offset: 0, rows: [1], below: 5, cursor: 0 }],
  [
    "a scrolled window at 100x12",
    "one-row-scrolled",
    { offset: 6, rows: [6], below: 8, cursor: 0 },
  ],
  [
    "a row beside the disclosure at 100x16",
    "one-row-disclosure",
    { offset: 4, rows: [5], below: 0, cursor: 1 },
  ],
] as const)("C-API-24 %s is Elwood's navigable picker", (_name, name, expected) => {
  const text = frame(name);
  expect(claudeModelPicker.activeDialog(text, { opened: true })).toBe("picker");
  const viewport = claudeModelPicker.parse(text).viewport;
  expect(viewport).toMatchObject({
    offset: expected.offset,
    remainingBelow: expected.below,
    cursorItemIndex: expected.cursor,
  });
  const rows = viewport?.items.flatMap((item) =>
    item.kind === "model" ? [item.row.absoluteRowNumber] : [],
  );
  expect(rows).toEqual(expected.rows);
});

test.each([
  ["a one-row window without a scroll marker", "one-row", "\n    ↓ 5 more"],
  ["a scroll marker without a row", "one-row-scrolled", /\n {2}❯ 6\..*\n {4}↓ 8 more/u],
] as const)("C-API-24 %s is not a picker window", (_name, name, removed) => {
  const text = frame(name).replace(removed, "");
  expect(text).not.toBe(frame(name));
  expect(claudeModelPicker.parse(text).viewport).toBeUndefined();
  expect(claudeModelPicker.activeDialog(text, { opened: true })).toBeUndefined();
});
