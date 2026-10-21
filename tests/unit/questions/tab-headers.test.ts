/** Native tab identity must match the complete request (C-QUESTION-03). */
import { expect, test } from "vitest";
import {
  matchesClaudeQuestionTabs,
  parseClaudeQuestionScreen,
} from "../../../src/claude/questions/screen.ts";
import { definitions, fixture, frame } from "./helpers.ts";

test.each([
  (text: string) => text.replace("☐ Color", "☐ Colors"),
  (text: string) => text.replace("☐ Color  ☐ Features", "☐ Features  ☐ Color"),
  (text: string) => text.replace("  ✔ Submit", "  ☐ Third  ✔ Submit"),
  (text: string) => text.replace("  ✔ Submit", ""),
])("C-QUESTION-03 rejects mismatched native tabs %#", (change) => {
  expect(
    parseClaudeQuestionScreen(frame(change(fixture("questions").text)), definitions),
  ).toBeUndefined();
});

test("C-QUESTION-03 rejects a grouped native dialog for a single-question request", () => {
  expect(parseClaudeQuestionScreen(fixture("questions"), definitions.slice(0, 1))).toBeUndefined();
  expect(parseClaudeQuestionScreen(fixture("questions"), [])).toBeUndefined();
  expect(matchesClaudeQuestionTabs(frame("foreign"), definitions)).toBe(false);
});
