/** Exact draft equality must not alias placeholders or continuation content (PRD §4). */
import { expect, test } from "vitest";
import { draftMatches } from "../../../src/codex/questions/draft.ts";
import { questionView } from "../../../src/codex/questions/frame.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
import { captured, frame } from "./helpers.ts";

const note: QuestionDefinition = {
  prompt: "ELWOOD_ASYNC_NOTE: What note?",
  options: [],
  selection: "none",
  textMode: "alternative",
  secret: false,
};
test("C-QUESTION-02 captured empty placeholder is not the literal answer text", () => {
  const empty = questionView(captured("async-after-first.txt"))!;
  expect(draftMatches(empty, note, "Type your answer")).toBe(false);
});
test("C-QUESTION-02 an indented caret continuation cannot replace the notes start", () => {
  const text = captured("blocking-modal-note.txt").text.replace(
    "  › ELWOOD_MODAL_NOTE_85",
    "  › x\n    › tail",
  );
  expect(draftMatches(questionView(frame(text))!, note, "tail")).toBe(false);
});
test("C-QUESTION-02 native row trimming cannot discard answer whitespace", () => {
  const text = captured("async-editor-note.txt").text.replace("ELWOOD_NOTE_74", "ELWOOD_NOTE_74  ");
  expect(draftMatches(questionView(frame(text))!, note, "ELWOOD_NOTE_74")).toBe(false);
});

test("C-QUESTION-02 incomplete editor metadata cannot authorize a draft", () => {
  const view = questionView(captured("async-editor-note.txt"))!;
  expect(draftMatches(view, { ...note, prompt: "missing prompt" }, "ELWOOD_NOTE_74")).toBe(false);
  expect(draftMatches({ ...view, rawBody: [note.prompt, " "] }, note, "")).toBe(false);
  const before = "  ELWOOD_NOTE_74";
  const owned = {
    ...view,
    cursor: {
      ...view.cursor,
      row: view.rawBody.findIndex((line) => line.includes("ELWOOD_NOTE_74")),
      visible: true,
      dimmed: false,
      before,
    },
  };
  expect(draftMatches(owned, note, "ELWOOD_NOTE_74")).toBe(true);
  for (const cursor of [
    { ...owned.cursor, visible: false },
    { ...owned.cursor, row: -1 },
    { ...owned.cursor, before: "  changed" },
  ])
    expect(draftMatches({ ...owned, cursor }, note, "ELWOOD_NOTE_74")).toBe(false);
});
