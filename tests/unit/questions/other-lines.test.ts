/** Native Other continuation rows cannot become controls (PRD §4). */
import { expect, test } from "vitest";
import { parseClaudeQuestionScreen } from "../../../src/claude/questions/screen.ts";
import { definitions, fixture, frame } from "./helpers.ts";

test.each([
  "1. Second item",
  "Submit",
])("preserves an indented Other continuation containing %s", (continuation) => {
  const question = {
    ...definitions[0]!,
    prompt: "Which test note?",
    header: "Note",
    options: [
      { label: "Brief (short)", description: "A short test note." },
      { label: "Detailed (long)", description: "A long test note." },
    ],
  };
  const current = frame(
    fixture("freeform-other-typed").text.replace("ELWOOD_NOTE_LINE2", continuation),
  );
  expect(parseClaudeQuestionScreen(current, [question])).toMatchObject({
    kind: "question",
    cursor: 2,
    other: `ELWOOD_NOTE_LINE1\n${continuation}`,
  });
});
