/** Bind complete native choice blocks, never matching metadata prefixes (PRD §4). */
import { expect, test } from "vitest";
import { matchesQuestion, questionView } from "../../../src/codex/questions/frame.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
import { captured, frame } from "./helpers.ts";

const queued: QuestionDefinition = {
  prompt: "ELWOOD_ASYNC_COLOR: Which color?",
  options: [{ label: "Amber" }, { label: "Blue" }],
  selection: "single",
  textMode: "alternative",
  secret: false,
};
test("C-QUESTION-02 queued option metadata must own the complete native block", () => {
  const view = questionView(captured("async-editor-first.txt"))!;
  expect(matchesQuestion(view, queued)).toBe(true);
  expect(matchesQuestion(view, { ...queued, options: [{ label: "Amber" }] })).toBe(false);
  for (const body of [
    view.body.filter((line) => !line.includes("3. Other")),
    view.body.flatMap((line) => (line.includes("3. Other") ? [line, "4. Foreign"] : [line])),
    view.body.flatMap((line) => (line.includes("3. Other") ? [line, "2. Blue"] : [line])),
    view.body.map((line) => line.replace("3. Other", "3. Something else")),
    view.body.map((line) => line.replace("2. Blue", "4. Blue")),
  ])
    expect(matchesQuestion({ ...view, body }, queued)).toBe(false);
});
test("C-QUESTION-02 modal metadata includes the native alternative exactly once", () => {
  const view = questionView(captured("blocking-modal-first.txt"))!;
  const modal: QuestionDefinition = {
    ...queued,
    prompt: "ELWOOD_MODAL_COLOR: Which color?",
    options: [
      { label: "Amber", description: "Warm" },
      { label: "Blue", description: "Cool" },
      { label: "None of the above", description: "Optionally, add details in notes (tab)" },
    ],
  };
  expect(matchesQuestion(view, modal)).toBe(true);
  expect(matchesQuestion(view, { ...modal, options: modal.options.slice(0, 2) })).toBe(false);
});
test("C-QUESTION-02 native free-text drafts may contain numbered answer text", () => {
  const text = captured("async-editor-note.txt").text.replace(
    "ELWOOD_NOTE_74",
    "1. first\n  2. second",
  );
  const note = { ...queued, prompt: "ELWOOD_ASYNC_NOTE: What note?", options: [] };
  expect(matchesQuestion(questionView(frame(text))!, note)).toBe(true);
});
