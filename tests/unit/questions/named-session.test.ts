/** A named Claude session keeps its labelled border under the questionnaire (PRD §5.10). */
import { expect, test } from "vitest";
import { parseClaudeQuestionScreen } from "../../../src/claude/questions/screen.ts";
import { fixture, frame, testPick } from "./helpers.ts";

// The capture's last row: the session name inset into the full-width bottom border.
const label = " Question Asker ─";
const namedBorderRow = `${"─".repeat(fixture("named-single-question", "2.1.310").cols - label.length)}${label}`;

function named(change: (text: string) => string = (text) => text) {
  const captured = fixture("named-single-question", "2.1.310");
  return { ...captured, ...frame(change(captured.text)), cursorRow: captured.cursorRow };
}

test("C-QUESTION-03 parses the questionnaire above a named session's border", () => {
  const captured = fixture("named-single-question", "2.1.310");
  expect(captured.lines).toContain(namedBorderRow);
  expect(parseClaudeQuestionScreen(captured, [testPick])).toMatchObject({
    kind: "question",
    questionIndex: 0,
    cursor: 0,
  });
});

test.each([
  ["a composer row", (text: string) => text.replace(namedBorderRow, "❯ draft")],
  ["prose", (text: string) => text.replace(namedBorderRow, "Question Asker")],
  [
    "content after the border",
    (text: string) => text.replace(namedBorderRow, `${namedBorderRow}\nok`),
  ],
  [
    "a second border",
    (text: string) => text.replace(namedBorderRow, `${namedBorderRow}\n${namedBorderRow}`),
  ],
])("rejects %s below the questionnaire footer", (_name, change) => {
  expect(parseClaudeQuestionScreen(named(change), [testPick])).toBeUndefined();
});
