/** Private parser authority follows native editor cursor bounds (C-QUESTION-03). */
import { expect, test } from "vitest";
import { parseClaudeQuestionScreen } from "../../../src/claude/questions/screen.ts";
import { definitions, frame, nativeSnapshot } from "./helpers.ts";

const note = {
  ...definitions[0]!,
  prompt: "Which test note?",
  header: "Note",
  options: [
    { label: "Brief (short)", description: "A short test note." },
    { label: "Detailed (long)", description: "A long test note." },
  ],
};

test("C-QUESTION-03 rejects a frame without native question chrome", () => {
  expect(parseClaudeQuestionScreen(frame("foreign"), definitions)).toBeUndefined();
});
test("C-QUESTION-03 accepts the captured multiline Other editor cursor", () => {
  expect(
    parseClaudeQuestionScreen(nativeSnapshot("freeform-other-typed-native"), [note]),
  ).toMatchObject({
    kind: "question",
    other: "ELWOOD_NOTE_LINE1\nELWOOD_NOTE_LINE2",
  });
});
test.each([-1, 2])("C-QUESTION-03 rejects a cursor outside the Other editor rows: %s", (offset) => {
  const current = nativeSnapshot("freeform-other-typed-native");
  const otherTop = current.lines.findIndex((line) => line.startsWith("❯ 3."));
  const cursorRow = otherTop + offset;
  expect(
    parseClaudeQuestionScreen({ ...current, cursorX: 5, cursorRow, cursorY: cursorRow }, [note]),
  ).toBeUndefined();
});
