/** A native Claude 2.1.332 Other row that keeps a replaced notice's blank cells (PRD §5.10, C-QUESTION-03). */
import { expect, test } from "vitest";
import { answerClaudeQuestions } from "../../../src/claude/questions/answer.ts";
import { parseClaudeQuestionScreen } from "../../../src/claude/questions/screen.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
import { validateQuestionAnswers } from "../../../src/core/questions/validate.ts";
import { claudeNoticeResidue } from "../../e2e/questions/claude-notice.ts";
import { nativeSnapshot, registry } from "./helpers.ts";
import { scriptedQuestionIo } from "./scripted-io-helpers.ts";

const note: QuestionDefinition = {
  prompt: "Which test note?",
  header: "Note",
  options: [
    { label: "Brief", description: "Short" },
    { label: "Detailed", description: "Long" },
  ],
  selection: "single",
  textMode: "alternative",
  supportsSecretInput: false,
};
const typedAnswer = "ELWOOD single line answer";
const native = (name: string) => nativeSnapshot(name, "2.1.332");
/** The single-choice Other row, which is the questionnaire's last row before its closing rule. */
const otherRow = (name: string) => native(name).lines.find((line) => /^(?:❯| ) 3\. /.test(line));

test("C-QUESTION-03 reads the Other row through blank cells only once the cursor ends the answer", () => {
  expect(otherRow("single-other-notice-native")).toMatch(claudeNoticeResidue);
  expect(otherRow("single-other-placeholder-native")).toMatch(/^❯ 3\. Type something\. {20,}$/);
  expect(otherRow("single-other-typed-native")).toMatch(/^❯ 3\. ELWOOD single line answer {20,}$/);
  expect(parseClaudeQuestionScreen(native("single-other-notice-native"), [note])).toMatchObject({
    cursor: 1,
  });
  // On the placeholder the cursor sits before the text, so the row is kept as drawn.
  expect(
    parseClaudeQuestionScreen(native("single-other-placeholder-native"), [note]),
  ).toMatchObject({
    kind: "question",
    cursor: 2,
    other: expect.stringMatching(/^Type something\. {20,}$/),
  });
  expect(parseClaudeQuestionScreen(native("single-other-typed-native"), [note])).toMatchObject({
    cursor: 2,
    other: typedAnswer,
  });
  // A second line grows the panel upward, so the cells stay on the editor's last row.
  expect(parseClaudeQuestionScreen(native("single-other-two-lines-native"), [note])).toMatchObject({
    cursor: 2,
    other: "ELWOOD_NOTE_LINE1_x\nELWOOD_NOTE_LINE2",
  });
});

test("C-QUESTION-03 keeps the answer's own trailing spaces before a notice's blank cells", () => {
  const typed = native("single-other-typed-native");
  const cursorLineBefore = `❯ 3. ${typedAnswer}  `;
  expect(
    parseClaudeQuestionScreen({ ...typed, cursorLineBefore, cursorX: cursorLineBefore.length }, [
      note,
    ]),
  ).toMatchObject({ other: `${typedAnswer}  ` });
});

test("C-QUESTION-03 types alternative text into an Other editor that keeps blank cells", async () => {
  const request = registry().publish("native", "blocking", [note])!;
  const answers = validateQuestionAnswers(request, [
    { questionId: request.questions[0]!.id, text: typedAnswer },
  ]);
  const { io, writes } = scriptedQuestionIo(native("single-other-notice-native"), [
    native("single-other-placeholder-native"),
    native("single-other-typed-native"),
  ]);
  await answerClaudeQuestions(request, answers, io);
  expect(writes).toEqual(["\x1b[B", `\x1b[200~${typedAnswer}\x1b[201~`, "\r"]);
});

test("C-QUESTION-03 never pastes over an Other draft that keeps blank cells", async () => {
  const request = registry().publish("native", "blocking", [note])!;
  const answers = validateQuestionAnswers(request, [
    { questionId: request.questions[0]!.id, text: "ELWOOD replacement" },
  ]);
  // The editor already holds a person's draft when Elwood's cursor reaches it.
  const { io, writes } = scriptedQuestionIo(native("single-other-notice-native"), [
    native("single-other-typed-native"),
  ]);
  await expect(answerClaudeQuestions(request, answers, io)).rejects.toThrow(
    "Native write was not authorized",
  );
  expect(writes).toEqual(["\x1b[B"]);
});

test("C-QUESTION-03 never pastes after a draft whose first line reads like the placeholder", async () => {
  const twoLines = native("single-other-two-lines-native");
  const lines = twoLines.lines.map((line) =>
    line.startsWith("❯ 3. ")
      ? "❯ 3. Type something."
      : line.startsWith("     ELWOOD_NOTE_LINE2")
        ? " ".repeat(line.length)
        : line,
  );
  const draft = {
    ...twoLines,
    lines,
    text: lines.join("\n"),
    cursorX: 5,
    cursorLineBefore: "     ",
  };
  expect(parseClaudeQuestionScreen(draft, [note])).toMatchObject({ other: "Type something.\n" });
  const request = registry().publish("native", "blocking", [note])!;
  const answers = validateQuestionAnswers(request, [
    { questionId: request.questions[0]!.id, text: "ELWOOD replacement" },
  ]);
  const { io, writes } = scriptedQuestionIo(native("single-other-notice-native"), [draft]);
  await expect(answerClaudeQuestions(request, answers, io)).rejects.toThrow(
    "Native write was not authorized",
  );
  expect(writes).toEqual(["\x1b[B"]);
});
