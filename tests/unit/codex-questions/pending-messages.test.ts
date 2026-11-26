/** Codex 0.172 shows answers it has not submitted yet above a queued panel (PRD §5.10). */
import { expect, test } from "vitest";
import { questionView } from "../../../src/codex/questions/frame.ts";
import { workingRowToPanel } from "../../../src/codex/questions/pending-messages.ts";
import { nativeFrame } from "./native-frame.ts";

// Captured while Codex had not yet submitted the literal answer: the hidden cursor is parked
// after the working row's glyph, and the pending-message block sits between it and the panel.
const pending = nativeFrame("remaining-color-pending-literal.json", "0.172.0");
const panel = pending.lines.lastIndexOf("• Queued follow-up inputs");
const between = pending.lines.slice(pending.cursorRow + 1, panel).map((line) => line.trimEnd());
const [header, item] = between.filter((line) => line !== "");

test("a hidden cursor above Codex's pending answers keeps the remaining choice", () => {
  expect(between.filter((line) => line !== "")).toHaveLength(3);
  expect(questionView(pending)).toMatchObject({ kind: "queued", count: 1, index: 0, selected: 0 });
});

test.each([
  ["blank rows", ["", ""], true],
  ["the captured block", between, true],
  ["deeper answer rows", [header!, item!, "      indented", "    › caret-tail"], true],
  ["the header alone", ["", header!, ""], false],
  ["an item row first", [item!, header!], false],
  ["an unindented answer row", [header!, item!, "  Type your answer"], false],
  ["an unrelated row", ["", "unrelated dialog", ""], false],
])("the rows between the working row and the panel: %s", (_, rows, expected) => {
  expect(workingRowToPanel(rows)).toBe(expected);
});
