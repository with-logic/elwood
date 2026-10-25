/** A named Claude session keeps its labelled border under the questionnaire (PRD §5.10). */
import { expect, test } from "vitest";
import { parseClaudeQuestionScreen } from "../../../src/claude/questions/screen.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
import { fixture, frame } from "./helpers.ts";

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
// The 140-column capture's last row: the session name inset into the bottom border.
const namedBorder = `${"─".repeat(123)} Question Asker ─`;

function named(change: (text: string) => string = (text) => text) {
  const captured = fixture("named-single-question", "2.1.310");
  return { ...captured, ...frame(change(captured.text)), cursorRow: captured.cursorRow };
}

test("C-QUESTION-03 parses the questionnaire above a named session's border", () => {
  const captured = fixture("named-single-question", "2.1.310");
  expect(captured.lines).toContain(namedBorder);
  expect(parseClaudeQuestionScreen(captured, [testPick])).toMatchObject({
    kind: "question",
    questionIndex: 0,
    cursor: 0,
  });
});

test.each([
  ["a composer row", (text: string) => text.replace(namedBorder, "❯ draft")],
  ["prose", (text: string) => text.replace(namedBorder, "Question Asker")],
  ["content after the border", (text: string) => text.replace(namedBorder, `${namedBorder}\nok`)],
  [
    "a second border",
    (text: string) => text.replace(namedBorder, `${namedBorder}\n${namedBorder}`),
  ],
])("rejects %s below the questionnaire footer", (_name, change) => {
  expect(parseClaudeQuestionScreen(named(change), [testPick])).toBeUndefined();
});
