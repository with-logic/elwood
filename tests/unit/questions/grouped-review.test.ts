/** Confirm grouped answers on Claude's compact review page (C-QUESTION-03). */
import { expect, test } from "vitest";
import { parseClaudeQuestionScreen } from "../../../src/claude/questions/screen.ts";
import { definitions, fixture, frame, testPick } from "./helpers.ts";

const captured = fixture("review", "2.1.329");
const questions = ["Shape", "Styles", "Size", "Color"].map((header) => ({
  ...testPick,
  header,
  prompt: `Which test ${header.toLowerCase()}?`,
}));
const summary =
  "● Which test shape? → Third ● Which test styles? → First, Second, Fourth ● Which test size? → Third ● Which test color? → First";

test("C-QUESTION-03 reads every answer above Submit in a named Claude 2.1.329 session", () => {
  expect(parseClaudeQuestionScreen(captured, questions)).toEqual({
    kind: "review",
    cursor: 0,
    summary,
  });
});

test.each([
  (s: string) => s.replace("  2. Cancel", "❯ 2. Cancel"),
  (s: string) => s.replace("Review your answers\n\n ●", "Review your answers ●"),
  (s: string) => s.replace("  2. Cancel", "  2. Cancel\n     Unexpected action"),
])("C-QUESTION-03 rejects ambiguous or extra review actions", (change) => {
  expect(parseClaudeQuestionScreen(frame(change(captured.text)), questions)).toBeUndefined();
});

test("C-QUESTION-03 reads Next on a grouped checkbox page", () => {
  const page = fixture("features-submit-highlight");
  const next = frame(page.text.replace("❯    Submit", "❯    Next"));
  expect(parseClaudeQuestionScreen(next, definitions)).toMatchObject({
    kind: "question",
    cursor: 3,
  });
  const single = frame(next.text.replace("←  ☒ Color  ☒ Features  ✔ Submit  →", " ☐ Features"));
  expect(parseClaudeQuestionScreen(single, [definitions[1]!])).toBeUndefined();
});

test("C-QUESTION-03 preserves the typed answer's trailing spaces under Claude's cursor", () => {
  const source = fixture("freeform-other-highlight");
  const typed = "A wide 界 and a space ";
  const current = frame(source.text.replace("❯ 3. Type something.", `❯ 3. ${typed} `));
  const cursorLineBefore = `❯ 3. ${typed}`;
  const question = {
    ...testPick,
    prompt: "Which test note?",
    header: "Note",
    options: [
      { label: "Brief (short)", description: "A short test note." },
      { label: "Detailed (long)", description: "A long test note." },
    ],
  };
  expect(
    parseClaudeQuestionScreen({ ...current, cursorLineBefore, cursorX: 25 }, [question]),
  ).toMatchObject({ other: typed });
  expect(
    parseClaudeQuestionScreen({ ...current, cursorX: 25, cursorLineBefore: "❯ 3. A" }, [question]),
  ).toMatchObject({ other: `${typed} ` });
});
