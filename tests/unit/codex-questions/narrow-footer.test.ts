/** Codex 0.172 wraps a queued panel's footer hints in a narrow pane (PRD §5.10, C-ATTN-02). */
import { expect, test } from "vitest";
import { blockingQuestionVisible } from "../../../src/codex/questions/chrome.ts";
import { questionView } from "../../../src/codex/questions/frame.ts";
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import { nativeFrame } from "./native-frame.ts";

const at = (name: string) => nativeFrame(name, "0.172.0");
// The color choice at 60 columns, `⇧← next question` on a row of its own.
const first = at("queued-footer-wrapped-60-first.json");
// The note editor at 50 columns, wrapped the same way.
const second = at("queued-footer-wrapped-50-second.json");
// The literal editor at 60 columns, whose shorter footer fits on one row.
const third = at("queued-footer-60-third.json");

/** The frame with its footer rows, the last two non-blank rows, replaced by `footer`. */
function withFooter(frame: QuestionFrame, footer: readonly string[]): QuestionFrame {
  const end = frame.lines.findLastIndex((line) => line.trim() !== "");
  const lines = [...frame.lines.slice(0, end - 1), ...footer, ...frame.lines.slice(end + 1)];
  return { ...frame, lines, text: lines.join("\n") };
}

test.each([
  ["the first choice, wrapped at 60 columns", first, 0, 0],
  ["the second editor, wrapped at 50 columns", second, 1, undefined],
  ["the third editor on one row at 60 columns", third, 2, undefined],
])("C-ATTN-02 a queued panel keeps its question with %s", (_, frame, index, selected) => {
  const view = questionView(frame);
  expect(view).toMatchObject({ kind: "queued", count: 3, index, selected });
  expect(view?.body.some((line) => line.startsWith("enter submit") || line.startsWith("⇧"))).toBe(
    false,
  );
  expect(blockingQuestionVisible(frame.text)).toBe(true);
});

test("C-ATTN-02 a queued panel keeps its question with the hints Codex wraps at 40 columns", () => {
  const narrow = withFooter(first, [
    "  enter submit   ⌃] skip",
    "  ⇧→ main prompt   ⇧← next question",
  ]);
  expect(questionView(narrow)).toMatchObject({ kind: "queued", count: 3, index: 0, selected: 0 });
  expect(blockingQuestionVisible(narrow.text)).toBe(true);
});

test.each([
  ["hints out of order", ["  ⌃] skip   ⇧→ main prompt", "  enter submit   ⇧← next question"]],
  [
    "more rows than hints",
    ["  enter submit", "  ⌃] skip", "  ⇧→ main prompt", "  ⇧← next", "  question"],
  ],
  ["a missing hint", ["  enter submit   ⇧→ main prompt", "  ⇧← next question"]],
  ["an unknown hint row", ["  enter submit   ⌃] skip   ⇧→ main prompt", "  ⇧← next page"]],
  ["hints run together", ["  enter submit ⌃] skip   ⇧→ main prompt", "  ⇧← next question"]],
])("C-ATTN-02 a wrapped queued footer refuses %s", (_, footer) => {
  const frame = withFooter(first, footer);
  expect(questionView(frame)).toBeUndefined();
  expect(blockingQuestionVisible(frame.text)).toBe(false);
});
