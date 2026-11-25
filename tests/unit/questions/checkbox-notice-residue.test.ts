/** Claude checkbox captures: notice blank cells, Submit, review, named (PRD §5.10, C-QUESTION-03). */
import { expect, test } from "vitest";
import { parseClaudeQuestionScreen } from "../../../src/claude/questions/screen.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
import { claudeNoticeResidue } from "../../e2e/questions/claude-notice.ts";
import { definitions, fixture, frame, nativeSnapshot332 as native } from "./helpers.ts";

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
const standalone = native("standalone-checkbox-notice-native");
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

test("C-QUESTION-03 reads a highlighted Submit row that keeps a notice's blank cells", () => {
  const submit = native("standalone-checkbox-submit-native");
  expect(submit.lines).toContainEqual(expect.stringMatching(/^❯ {4}Submit {20,}$/));
  // The hidden cursor parks at the viewport's last row, not on the highlighted Submit row.
  expect(submit).toMatchObject({ cursorX: 0, cursorRow: 44, cursorVisible: false });
  expect(parseClaudeQuestionScreen(submit, [fruits])).toMatchObject({
    kind: "question",
    hasSubmitTab: true,
    cursor: 4,
    checked: [true, false, true, false],
  });
});

test("C-QUESTION-03 reads the standalone checkbox review at its captured cursor", () => {
  const review = native("standalone-checkbox-review-native");
  expect(review).toMatchObject({ cursorX: 0, cursorRow: 37, cursorVisible: false });
  expect(parseClaudeQuestionScreen(review, [fruits])).toEqual({
    kind: "review",
    cursor: 0,
    summary: "● Which test fruits?\n→ Apple, Cherry",
  });
});

test("C-QUESTION-03 reads a named session's checkbox, whose closing rule replaced the notice row", () => {
  const named = native("named-standalone-checkbox-native");
  expect(named.lines.at(-1)).toMatch(/^─+ Question Asker ─$/);
  expect(named.lines.at(-2)).toBe("Enter to select · ↑/↓ to navigate · Esc to cancel");
  expect(named.text).not.toMatch(claudeNoticeResidue);
  expect(named).toMatchObject({ cursorX: 0, cursorRow: 32, cursorVisible: false });
  expect(parseClaudeQuestionScreen(named, [fruits])).toMatchObject({
    kind: "question",
    hasSubmitTab: true,
    cursor: 0,
    checked: [false, false, false, false],
  });
});
