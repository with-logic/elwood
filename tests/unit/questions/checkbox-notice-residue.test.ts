/** Claude checkbox action rows that keep a replaced notice's blank cells (PRD §5.10, C-QUESTION-03). */
import { expect, test } from "vitest";
import { parseClaudeQuestionScreen } from "../../../src/claude/questions/screen.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
import { claudeNoticeResidue } from "../../e2e/questions/claude-notice.ts";
import { definitions, fixture, frame, nativeSnapshot } from "./helpers.ts";

const fruits: QuestionDefinition = {
  prompt: "Which test fruits?",
  header: "Fruits",
  options: [
    { label: "Apple", description: "Red" },
    { label: "Banana", description: "Yellow" },
    { label: "Cherry", description: "Dark" },
  ],
  selection: "multiple",
  textMode: "none",
  supportsSecretInput: false,
};
const standalone = nativeSnapshot("standalone-checkbox-notice-native", "2.1.332");
const submitRow = /^ {5}Submit {20,}$/;
const withSubmitRow = (row: string) => {
  const lines = standalone.lines.map((line) => (submitRow.test(line) ? row : line));
  return { ...standalone, lines, text: lines.join("\n") };
};

test("C-QUESTION-03 parses a standalone checkbox whose Submit row keeps blank cells", () => {
  expect(standalone.lines.filter((line) => submitRow.test(line))).toHaveLength(1);
  expect(standalone.text).toMatch(claudeNoticeResidue);
  expect(parseClaudeQuestionScreen(standalone, [fruits])).toMatchObject({
    kind: "question",
    hasSubmitTab: true,
    cursor: 0,
    checked: [false, false, false, false],
  });
});

test("C-QUESTION-03 rejects a Submit row that still shows notice text", () => {
  const row = `     Submit${" ".repeat(20)}Thinking can't be turned off for Haiku 5.5`;
  expect(parseClaudeQuestionScreen(withSubmitRow(row), [fruits])).toBeUndefined();
});

test("C-QUESTION-03 reads a grouped checkbox page whose Next row keeps blank cells", () => {
  const page = fixture("features-submit-highlight");
  const next = frame(page.text.replace("❯    Submit", `❯    Next${" ".repeat(80)}`));
  expect(next.text).not.toBe(page.text);
  expect(parseClaudeQuestionScreen(next, definitions)).toMatchObject({
    kind: "question",
    questionIndex: 1,
    cursor: 3,
  });
});
