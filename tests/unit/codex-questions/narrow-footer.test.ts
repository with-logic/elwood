/** Codex 0.172 wraps question footers in a narrow pane (PRD §5.3/§5.10, C-ATTN-02, C-QUESTION-04). */
import { expect, test } from "vitest";
import { blockingQuestionVisible } from "../../../src/codex/questions/chrome.ts";
import { questionView } from "../../../src/codex/questions/frame.ts";
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import { nativeFrame } from "./native-frame.ts";

const at = (name: string) => nativeFrame(name, "0.172.0");
// The queued color choice at 60 columns, `⇧← next question` on a row of its own.
const queuedFirst = at("queued-footer-wrapped-60-first.json");
// The queued note editor at 50 columns, wrapped the same way.
const queuedSecond = at("queued-footer-wrapped-50-second.json");
// The last queued editor at 60 columns, whose shorter footer fits on one row.
const queuedLast = at("queued-footer-60-third.json");
// The first of three modal questions: its footer puts its last hint on a row of its own at 80
// columns, splits after the second hint at 60 and 50, and takes a row per hint at 40.
const modalFrames = [80, 60, 50, 40].map(
  (cols) => [cols, at(`modal-footer-wrapped-${cols}.json`)] as const,
);
const [, modal80] = modalFrames[0]!;

/** The frame with its two footer rows, below a blank row, replaced by `footer`. */
function withFooter(frame: QuestionFrame, footer: readonly string[]): QuestionFrame {
  const end = frame.lines.findLastIndex((line) => line.trim() !== "");
  if (frame.lines[end - 1]!.trim() === "" || frame.lines[end - 2]!.trim() !== "")
    throw new Error("withFooter needs a frame whose footer has two rows");
  const lines = [...frame.lines.slice(0, end - 1), ...footer, ...frame.lines.slice(end + 1)];
  return { ...frame, lines, text: lines.join("\n") };
}
const choiceTail = ["› 1. Amber", "2. Blue", "3. Other", ""];
const editorTail = ["", "Type your answer", ""];

test.each([
  ["the first choice, wrapped at 60 columns", queuedFirst, 0, 0, choiceTail],
  ["the second editor, wrapped at 50 columns", queuedSecond, 1, undefined, editorTail],
  ["the last editor on one row at 60 columns", queuedLast, 2, undefined, editorTail],
])("C-QUESTION-04 C-ATTN-02 a queued panel keeps %s", (_, frame, index, selected, tail) => {
  const view = questionView(frame);
  expect(view).toMatchObject({ kind: "queued", count: 3, index, selected });
  // The body ends exactly above the footer's first row.
  expect(view?.body.slice(-tail.length)).toEqual(tail);
  expect(blockingQuestionVisible(frame.text)).toBe(true);
});

test.each([
  [
    "two rows, as at 40 columns",
    ["  enter submit   ⌃] skip", "  ⇧→ main prompt   ⇧← next question"],
  ],
  ["three rows", ["  enter submit   ⌃] skip", "  ⇧→ main prompt", "  ⇧← next question"]],
  ["a row per hint", ["  enter submit", "  ⌃] skip", "  ⇧→ main prompt", "  ⇧← next question"]],
])("C-QUESTION-04 C-ATTN-02 a queued panel keeps its footer wrapped onto %s", (_, footer) => {
  const narrow = withFooter(queuedFirst, footer);
  const view = questionView(narrow);
  expect(view).toMatchObject({ kind: "queued", count: 3, index: 0, selected: 0 });
  expect(view?.body.slice(-choiceTail.length)).toEqual(choiceTail);
  expect(blockingQuestionVisible(narrow.text)).toBe(true);
});

test.each(
  modalFrames,
)("C-QUESTION-04 C-ATTN-02 a modal question keeps its wrapped footer at %i columns", (_, frame) => {
  const view = questionView(frame);
  expect(view).toMatchObject({ kind: "blocking", count: 3, index: 0, selected: 0, notes: false });
  expect(view?.body[0]).toBe("ELWOOD_MODAL_COLOR: Which color?");
  // The body ends with the wrapped option description, exactly above the footer.
  expect(view?.body.slice(-2)).toEqual([expect.stringMatching(/\(tab\)$/), ""]);
  expect(blockingQuestionVisible(frame.text)).toBe(true);
});

test("C-QUESTION-04 C-ATTN-02 a modal notes editor keeps its wrapped footer", () => {
  const notes = withFooter(modal80, ["  tab or esc to clear notes", "  enter to submit answer"]);
  expect(questionView(notes)).toMatchObject({ kind: "blocking", count: 3, notes: true });
  expect(blockingQuestionVisible(notes.text)).toBe(true);
});

test.each([
  [
    "queued hints out of order",
    ["  ⌃] skip   ⇧→ main prompt", "  enter submit   ⇧← next question"],
  ],
  [
    "a queued hint split across rows",
    ["  enter submit   ⌃] skip   ⇧→ main prompt   ⇧← next", "  question"],
  ],
  ["a missing queued hint", ["  enter submit   ⇧→ main prompt", "  ⇧← next question"]],
  ["an unknown queued hint", ["  enter submit   ⌃] skip   ⇧→ main prompt", "  ⇧← next page"]],
  ["queued hints run together", ["  enter submit ⌃] skip   ⇧→ main prompt", "  ⇧← next question"]],
  [
    "an unknown row above valid hints",
    ["  ⇧↑ history", "  enter submit   ⌃] skip   ⇧→ main prompt", "  ⇧← next question"],
  ],
])("C-QUESTION-04 C-ATTN-02 a wrapped queued footer refuses %s", (_, footer) => {
  const frame = withFooter(queuedFirst, footer);
  expect(questionView(frame)).toBeUndefined();
  expect(blockingQuestionVisible(frame.text)).toBe(false);
});

// Under the modal question header, so only the footer grammar can refuse these.
test.each([
  [
    "modal hints out of order",
    [
      "  ←/→ to navigate questions | esc to interrupt",
      "  tab to add notes | enter to submit answer",
    ],
  ],
  [
    "a modal hint split across rows",
    [
      "  tab to add notes | enter to submit",
      "  answer | ←/→ to navigate questions | esc to interrupt",
    ],
  ],
  [
    "queued and modal hints mixed",
    ["  tab to add notes | enter to submit answer", "  ⇧← next question"],
  ],
  [
    "an unknown row above valid hints",
    [
      "  ctrl+o to expand",
      "  tab to add notes | enter to submit answer | ←/→ to navigate questions",
      "  esc to interrupt",
    ],
  ],
])("C-QUESTION-04 C-ATTN-02 a wrapped modal footer refuses %s", (_, footer) => {
  const frame = withFooter(modal80, footer);
  expect(questionView(frame)).toBeUndefined();
  expect(blockingQuestionVisible(frame.text)).toBe(false);
});

test("C-QUESTION-04 C-ATTN-02 a wrapped modal footer still needs its question header", () => {
  const lines = modal80.lines.map((line) => line.replace("Question 1/3", "Questions 1/3"));
  const headless = { ...modal80, lines, text: lines.join("\n") };
  expect(questionView(headless)).toBeUndefined();
  expect(blockingQuestionVisible(headless.text)).toBe(false);
});
