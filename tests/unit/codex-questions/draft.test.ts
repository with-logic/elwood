/** Exact native draft and placeholder assertions split from frame recognition (PRD §4). */
import { expect, test } from "vitest";
import { draftMatches } from "../../../src/codex/questions/draft.ts";
import { questionView } from "../../../src/codex/questions/frame.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
import { captured, frame } from "./helpers.ts";

test("checks exact native drafts without treating placeholders as answers", () => {
  const note: QuestionDefinition = {
    prompt: "ELWOOD_ASYNC_NOTE: What note?",
    options: [],
    selection: "none",
    textMode: "alternative",
    secret: false,
  };
  const freeFrame = captured("async-after-first.txt");
  const freeRow = freeFrame.lines.findIndex((line) => line.trim() === "Type your answer");
  const free = questionView({
    ...freeFrame,
    cursorRow: freeRow,
    cursorY: freeRow,
    cursorX: 2,
    cursorVisible: true,
    cursorCellDimmed: true,
    cursorLineBefore: "  ",
  })!;
  expect(draftMatches(free, note, "")).toBe(true);
  expect(draftMatches(free, note, "Not staged")).toBe(false);
  const typed = questionView(captured("async-editor-note.txt"))!;
  expect(draftMatches(typed, note, "ELWOOD_NOTE_74")).toBe(true);
  const modal = questionView(captured("blocking-modal-note.txt"))!;
  expect(draftMatches(modal, note, "ELWOOD_MODAL_NOTE_85")).toBe(true);
  expect(draftMatches({ ...modal, notes: false }, note, "")).toBe(false);
  expect(draftMatches({ ...modal, rawBody: [] }, note, "")).toBe(false);
  const color: QuestionDefinition = {
    ...note,
    prompt: "ELWOOD_ASYNC_COLOR: Which color?",
    options: [{ label: "Amber" }, { label: "Blue" }],
  };
  expect(draftMatches(questionView(captured("async-editor-first.txt"))!, color, "")).toBe(false);
  const otherFrame = frame(
    captured("async-editor-first.txt")
      .text.replace("  › 1. Amber", "    1. Amber")
      .replace("    3. Other", "  › 3. Other"),
  );
  const otherRow = otherFrame.lines.findIndex((line) => line.includes("› 3. Other"));
  const other = questionView({
    ...otherFrame,
    cursorRow: otherRow,
    cursorY: otherRow,
    cursorX: 7,
    cursorVisible: true,
    cursorCellDimmed: true,
    cursorLineBefore: "  › 3. ",
  })!;
  expect(draftMatches(other, color, "")).toBe(true);
  expect(draftMatches({ ...other, rawBody: [] }, color, "")).toBe(false);
  const collision = { ...color, options: [{ label: "Other" }, { label: "Blue" }] };
  const explicit = {
    ...other,
    rawBody: other.rawBody.map((line) =>
      line.replace("› 3. Other", "› 3. Other (write an answer)"),
    ),
  };
  expect(draftMatches(explicit, collision, "")).toBe(true);
  const multi = questionView(
    frame(
      captured("async-editor-note.txt").text.replace("  ELWOOD_NOTE_74", "  Line one\n  Line two"),
    ),
  )!;
  // Native wrapping and invisible interior spaces make a viewport insufficient for exact multiline proof.
  expect(draftMatches(multi, note, "Line one\nLine two")).toBe(false);
});
