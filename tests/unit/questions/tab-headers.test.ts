/** Native tab identity must match the complete request (PRD §4). */
import { expect, test } from "vitest";
import {
  matchesClaudeQuestionTabs,
  parseClaudeQuestionScreen,
} from "../../../src/claude/questions/screen.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
import { definitions, fixture, frame } from "./helpers.ts";

test.each([
  (text: string) => text.replace("☐ Color", "☐ Colors"),
  (text: string) => text.replace("☐ Color  ☐ Features", "☐ Features  ☐ Color"),
  (text: string) => text.replace("  ✔ Submit", "  ☐ Third  ✔ Submit"),
  (text: string) => text.replace("  ✔ Submit", ""),
])("rejects mismatched native tabs %#", (change) => {
  expect(
    parseClaudeQuestionScreen(frame(change(fixture("questions").text)), definitions),
  ).toBeUndefined();
});

test("accepts the padded single-question chip Claude 2.1.310 renders", () => {
  const testPick: QuestionDefinition = {
    prompt: "Which option would you like to pick for this test?",
    header: "Test pick",
    options: [
      { label: "Option A", description: "First option." },
      { label: "Option B", description: "Second option." },
      { label: "Option C", description: "Third option." },
    ],
    selection: "single",
    textMode: "alternative",
    supportsSecretInput: false,
  };
  const padded = fixture("single-question", "2.1.310");
  expect(padded.lines).toContain(" ☐ Test pick ");
  expect(matchesClaudeQuestionTabs(padded, [testPick])).toBe(true);
  expect(parseClaudeQuestionScreen(padded, [testPick])).toMatchObject({
    kind: "question",
    questionIndex: 0,
    cursor: 0,
  });
  // Only trailing padding is chrome: a different header still fails.
  expect(matchesClaudeQuestionTabs(padded, [{ ...testPick, header: "Test" }])).toBe(false);
});

test("rejects a grouped native dialog for a single-question request", () => {
  expect(parseClaudeQuestionScreen(fixture("questions"), definitions.slice(0, 1))).toBeUndefined();
  expect(parseClaudeQuestionScreen(fixture("questions"), [])).toBeUndefined();
  expect(matchesClaudeQuestionTabs(frame("foreign"), definitions)).toBe(false);
});
