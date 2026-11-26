/** Bound deferred-submission evidence to the current native work region (PRD §4, §5.10). */
import { expect, test } from "vitest";
import { questionView } from "../../../src/codex/questions/frame.ts";
import {
  blankOrPendingMessages,
  nativePendingPrompts,
  nativeQuestionFragment,
} from "../../../src/codex/questions/native-pending.ts";
import { frame } from "./helpers.ts";
import { nativeFrame } from "./native-frame.ts";

test("a pending submission survives before the editor finishes painting", () => {
  const working = "• Working (3s • esc to interrupt)";
  const pending =
    "• Messages to be submitted after next tool call (press esc to interrupt and send immediately)\n  ↳ > Q";
  expect([...nativePendingPrompts(frame(`${working}\n${pending}`))]).toEqual(["Q"]);
  expect([...nativePendingPrompts(frame(`${pending}\n${working}`))]).toEqual([]);
});

test("unanchored pending rows cannot identify a current submission", () => {
  expect(
    nativePendingPrompts(frame("• Messages to be submitted after next tool call\n  ↳ > Q")),
  ).toEqual([]);
});

test.each([
  "›",
  "»",
])("C-QUESTION-04 the %s composer ends pending-submission evidence", (marker) => {
  const text =
    "• Working (3s • esc to interrupt)\n" +
    "• Messages to be submitted after next tool call\n  ↳ > Q\n" +
    `${marker} Ask Codex to do anything\n  ↳ > unrelated history`;
  expect(nativePendingPrompts(frame(text))).toEqual(["Q"]);
});

test("a blank row ends bounded quotation before a partially painted panel", () => {
  expect(
    nativeQuestionFragment(frame("• Explanation:\n  Quoted body\n\n  Question 1/2 (2 unanswered)")),
  ).toBe(true);
});

// Captured while Codex had not yet submitted the literal answer: the hidden cursor is parked
// after the working row's glyph, and the pending-message block sits between it and the panel.
const pending = nativeFrame("remaining-color-pending-literal.json", "0.172.0");
const panelRow = pending.lines.lastIndexOf("• Queued follow-up inputs");
const between = pending.lines.slice(pending.cursorRow + 1, panelRow).map((row) => row.trimEnd());
const [header, item] = between.filter((row) => row !== "");
// The same header as Codex 0.163.0 wrapped it in a 60-column pane
// (`codex-0.163.0/questions/editor/queued-long-typed-narrow.json`).
const narrow = nativeFrame("editor/queued-long-typed-narrow.json").lines.slice(3, 6);

test("a hidden cursor above Codex's pending answers keeps the remaining choice", () => {
  expect(between.filter((row) => row !== "")).toHaveLength(3);
  expect(questionView(pending)).toMatchObject({ kind: "queued", count: 1, index: 0, selected: 0 });
});

test.each([
  ["blank rows", ["", ""], true],
  ["the captured block", between, true],
  ["a header a narrow pane wrapped", narrow, true],
  ["deeper answer rows", [header!, item!, "      indented", "    › caret-tail"], true],
  [
    "two pending answers",
    [header!, item!, "    Blue", "  ↳ > ELWOOD_ASYNC_SIZE: Which size?", "    Large"],
    true,
  ],
  ["the header alone", ["", header!, ""], false],
  ["the header's first words alone", [narrow[0]!, item!], false],
  ["an item row first", [item!, header!], false],
  ["an unindented answer row", [header!, item!, "  Type your answer"], false],
  ["an unrelated row", ["", "unrelated dialog", ""], false],
])("the rows between the working row and the panel: %s", (_, rows, expected) => {
  expect(blankOrPendingMessages(rows)).toBe(expected);
});
