/** Complete queued ownership permits its active native alternative editor (PRD §4). */
import { expect, test } from "vitest";
import { matchesQuestion, questionView } from "../../../src/codex/questions/frame.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
import { captured } from "./helpers.ts";

const question: QuestionDefinition = {
  prompt: "ELWOOD_ASYNC_COLOR: Which color?",
  options: [{ label: "Amber" }, { label: "Blue" }],
  selection: "single",
  textMode: "alternative",
  supportsSecretInput: false,
};
test("editable queued alternative retains metadata ownership", () => {
  const text = captured("async-editor-first.txt")
    .text.replace("› 1. Amber", "  1. Amber")
    .replace("    3. Other", "  › 3. typed answer");
  const original = captured("async-editor-first.txt");
  const lines = text.split("\n");
  const cursorRow = lines.findIndex((line) => line.includes("› 3. typed answer"));
  const view = questionView({
    ...original,
    text,
    lines,
    cursorRow,
    cursorY: cursorRow,
    cursorVisible: true,
    cursorCellDimmed: false,
    cursorLineBefore: "  › 3. typed answer",
  })!;
  expect(matchesQuestion(view, question)).toBe(true);
  for (const cursor of [
    { ...view.cursor, visible: false },
    { ...view.cursor, before: undefined },
    { ...view.cursor, row: -1 },
    { ...view.cursor, row: view.rawBody.length },
  ])
    expect(matchesQuestion({ ...view, cursor }, question)).toBe(false);
  const noBlanks = view.body.filter((line) => line.length > 0);
  expect(matchesQuestion({ ...view, body: noBlanks, cursor: view.cursor }, question)).toBe(true);
});
test("explicit Other suggestion keeps a separate native text alternative", () => {
  const original = questionView(captured("async-editor-first.txt"))!;
  const body = original.body.map((line) =>
    line.replace("1. Amber", "1. Other").replace("3. Other", "3. Other (write an answer)"),
  );
  expect(
    matchesQuestion(
      { ...original, body },
      { ...question, options: [{ label: "Other" }, { label: "Blue" }] },
    ),
  ).toBe(true);
  const malformed = original.body.map((line) => line.replace("2. Blue", "unknown native row"));
  expect(matchesQuestion({ ...original, body: malformed }, question)).toBe(false);
  expect(matchesQuestion(original, { ...question, options: [] })).toBe(false);
});
