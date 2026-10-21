/** Native blocking footer recognition is independent of the question parser (PRD §4). */
import { expect, test } from "vitest";
import { blockingQuestionVisible } from "../../../src/codex/questions/chrome.ts";

test("C-QUESTION-01 blocking chrome requires its native header and terminal footer", () => {
  const header = "Question 1/2 (2 unanswered)";
  expect(
    blockingQuestionVisible(
      `${header}\ntab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt`,
    ),
  ).toBe(true);
  expect(
    blockingQuestionVisible(`${header}\ntab or esc to clear notes | enter to submit all`),
  ).toBe(true);
  expect(blockingQuestionVisible(`${header}\nOther footer`)).toBe(false);
  expect(blockingQuestionVisible("tab or esc to clear notes | enter to submit answer")).toBe(false);
  expect(blockingQuestionVisible("")).toBe(false);
});
