/** Codex question chrome reads a frame's last rows from its end (PRD §5.10, C-QUESTION-04). */
import { expect, test } from "vitest";
import { lastRows } from "../../../src/codex/questions/chrome.ts";

test.each([
  ["", 5],
  ["one row", 5],
  ["a\nb\nc", 2],
  ["a\nb\nc", 3],
  ["\nleading blank", 5],
  ["a\n\n\nb", 3],
  ["six\nrows\nof\nscreen\ntext\nhere", 5],
] as const)("C-QUESTION-04 lastRows(%j, %i) equals the split screen's last rows", (text, count) => {
  expect(lastRows(text, count)).toEqual(text.split("\n").slice(-count));
});
