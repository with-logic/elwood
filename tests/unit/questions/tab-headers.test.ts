/** Native tab identity must match the complete request (PRD §4). */
import { expect, test } from "vitest";
import { parseClaudeQuestionScreen } from "../../../src/claude/questions/screen.ts";
import { definitions, fixture, frame, testPick } from "./helpers.ts";

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
  const padded = fixture("single-question", "2.1.310");
  expect(padded.lines).toContain(" ☐ Test pick ");
  expect(parseClaudeQuestionScreen(padded, [testPick])).toMatchObject({
    kind: "question",
    questionIndex: 0,
    cursor: 0,
  });
  // Only trailing padding is chrome: a different header still fails.
  expect(parseClaudeQuestionScreen(padded, [{ ...testPick, header: "Test" }])).toBeUndefined();
});

test("rejects a grouped native dialog for a single-question request", () => {
  expect(parseClaudeQuestionScreen(fixture("questions"), definitions.slice(0, 1))).toBeUndefined();
  expect(parseClaudeQuestionScreen(fixture("questions"), [])).toBeUndefined();
  expect(parseClaudeQuestionScreen(frame("foreign"), definitions)).toBeUndefined();
  const missingFirst: (typeof testPick)[] = [];
  missingFirst.length = 1;
  expect(parseClaudeQuestionScreen(fixture("questions"), missingFirst)).toBeUndefined();
});
