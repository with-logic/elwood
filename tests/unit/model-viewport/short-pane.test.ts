/**
 * Claude 2.1.332 sizes its model window to the pane. Below about 22 rows a window holds one
 * item (a model row, or only the `More models` disclosure) or a row beside the disclosure,
 * and a counted scroll marker vouches for the items it hides (PRD §5.3, C-API-23, C-API-24).
 */
import { expect, test } from "vitest";
import { claudeModelPicker } from "../../../src/claude/model-picker.ts";
import { codexModelPicker } from "../../../src/codex/model-picker.ts";
import { capturedFrame } from "../../helpers/captured-frames.ts";

const frame = (fixture: string) => capturedFrame(`claude-2.1.332/model-picker/${fixture}`);

test.each([
  [
    "the opening window at 100x12",
    "one-row",
    { offset: 0, rows: [1], remainingBelow: 5, cursorItemIndex: 0 },
  ],
  [
    "a scrolled window at 100x12",
    "one-row-scrolled",
    { offset: 6, rows: [6], remainingBelow: 8, cursorItemIndex: 0 },
  ],
  [
    "a row beside the disclosure at 100x16",
    "one-row-disclosure",
    { offset: 4, rows: [5], remainingBelow: 0, cursorItemIndex: 1 },
  ],
  [
    "a collapsed disclosure alone at 100x12",
    "disclosure-only",
    { offset: 5, rows: [], remainingBelow: 0, cursorItemIndex: 0 },
  ],
  [
    "an expanded disclosure alone at 100x12",
    "disclosure-only-expanded",
    { offset: 5, rows: [], remainingBelow: 9, cursorItemIndex: 0 },
  ],
] as const)("C-API-24 %s is Elwood's navigable picker", (_description, fixture, expected) => {
  const text = frame(fixture);
  expect(claudeModelPicker.activeDialog(text, { opened: true })).toBe("picker");
  const viewport = claudeModelPicker.parse(text).viewport;
  const { rows, ...position } = expected;
  expect(viewport).toMatchObject(position);
  const modelRows = viewport?.items.flatMap((item) =>
    item.kind === "model" ? [item.row.absoluteRowNumber] : [],
  );
  expect(modelRows).toEqual(rows);
});

test.each([
  ["a one-row window without a scroll marker", "one-row", "\n    ↓ 5 more"],
  ["a scroll marker with no item", "one-row-scrolled", /\n {2}❯ 6\..*\n {4}↓ 8 more/u],
] as const)("C-API-24 %s is not a picker window", (_description, fixture, removed) => {
  const text = frame(fixture).replace(removed, "");
  expect(text).not.toBe(frame(fixture));
  expect(claudeModelPicker.parse(text).viewport).toBeUndefined();
  expect(claudeModelPicker.activeDialog(text, { opened: true })).toBeUndefined();
});

test("C-API-24 Codex's bare arrows count nothing, so they never vouch for a one-row window", () => {
  const middle = capturedFrame("codex-0.169.0/model-picker/middle");
  const oneRow = middle.replace(/↑\n(?: {2}\d\..*\n)+(› 9\..*\n)↓/u, "↑\n$1↓");
  expect(oneRow).not.toBe(middle);
  expect(codexModelPicker.activeDialog(middle, { opened: true })).toBe("picker");
  expect(codexModelPicker.parse(oneRow).viewport).toBeUndefined();
  expect(codexModelPicker.activeDialog(oneRow, { opened: true })).toBeUndefined();
});
