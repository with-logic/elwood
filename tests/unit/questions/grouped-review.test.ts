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
  "● Which test shape?\n→ Third\n● Which test styles?\n→ First, Second, Fourth\n● Which test size?\n→ Third\n● Which test color?\n→ First";

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
  const duplicate = frame(next.text.replace("  1. [✔]", "❯ 1. [✔]"));
  expect(parseClaudeQuestionScreen(duplicate, definitions)).toBeUndefined();
});

test("C-QUESTION-03 accepts Submit as the only action for a single checkbox question", () => {
  const page = fixture("features-submit-highlight");
  const single = frame(page.text.replace("←  ☒ Color  ☒ Features  ✔ Submit  →", " ☐ Features"));
  const request = [definitions[1]!];
  expect(parseClaudeQuestionScreen(single, request)).toMatchObject({
    kind: "question",
    cursor: 3,
    checked: [true, true, false],
  });
  const next = frame(single.text.replace("❯    Submit", "❯    Next"));
  expect(parseClaudeQuestionScreen(next, request)).toBeUndefined();
});
