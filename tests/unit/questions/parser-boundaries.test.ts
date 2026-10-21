/** Private parser authority follows native editor cursor bounds (PRD §4). */
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

test("rejects a frame without native question chrome", () => {
  expect(parseClaudeQuestionScreen(frame("foreign"), definitions)).toBeUndefined();
});
test("accepts the captured multiline Other editor cursor", () => {
  expect(
    parseClaudeQuestionScreen(nativeSnapshot("freeform-other-typed-native"), [note]),
  ).toMatchObject({
    kind: "question",
    other: "ELWOOD_NOTE_LINE1\nELWOOD_NOTE_LINE2",
  });
});
test.each([-1, 2])("rejects a cursor outside the Other editor rows: %s", (offset) => {
  const current = nativeSnapshot("freeform-other-typed-native");
  const otherTop = current.lines.findIndex((line) => line.startsWith("❯ 3."));
  const cursorRow = otherTop + offset;
  expect(
    parseClaudeQuestionScreen({ ...current, cursorX: 5, cursorRow, cursorY: cursorRow }, [note]),
  ).toBeUndefined();
});
