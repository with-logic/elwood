/** Claude alternative text its editor and review draw across rows or with tabs as spaces (PRD §5.10, C-QUESTION-03). */
import { expect, test } from "vitest";
import { answerClaudeQuestions } from "../../../src/claude/questions/answer.ts";
import { claudeDrawnTextMatcher } from "../../../src/claude/questions/rows.ts";
import { parseClaudeQuestionScreen } from "../../../src/claude/questions/screen.ts";
import { validateQuestionAnswers } from "../../../src/core/questions/validate.ts";
import { groupedTextAnswerFrames } from "./grouped-frame-helpers.ts";
import { definitions, fixture, nativeSnapshot332 as native, registry } from "./helpers.ts";
import { answerNoteWith, color, note } from "./native-note-helpers.ts";
import { scriptedQuestionIo } from "./scripted-io-helpers.ts";

const words = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, index) => `w${String(from + index).padStart(3, "0")}`).join(
    " ",
  );
const pasted = (text: string) => `\x1b[200~${text}\x1b[201~`;
const link = `https://example.com/${"a".repeat(280)}`;
// At 140 columns: the editor indents 5 cells and leaves its last cell free; the review's first row
// starts with `   → ` and its continuation rows indent 3 cells.
const editorRowCells = 134;
const reviewFirstRowCells = 135;
const reviewRowCells = 137;
const rowsOf = (text: string, first: number, rest: number) => {
  const rows = [text.slice(0, first)];
  for (let at = first; at < text.length; at += rest) rows.push(text.slice(at, at + rest));
  return rows;
};

test.each([
  ["a\nb", "a b", true],
  ["a\nb", "ab", true],
  ["a\n\nb", "a\r\n\r\nb", true],
  ["a b", "ab", false],
  ["a\nb", "a", false],
  ["a", "a b", false],
] as const)("C-QUESTION-03 rows %j show %j: %s", (rows, text, shown) => {
  expect(claudeDrawnTextMatcher(text)(rows)).toBe(shown);
});

test("C-QUESTION-03 confirms a long line that Claude's editor wraps onto continuation rows", async () => {
  // Claude breaks at word boundaries and indents each continuation like a typed newline.
  expect(parseClaudeQuestionScreen(native("single-other-wrapped-native"), [note])).toMatchObject({
    other: `${words(0, 27)}\n${words(27, 53)}\n${words(53, 70)}`,
  });
  const line = words(0, 70);
  expect(await answerNoteWith(line, "single-other-wrapped-native")).toEqual([
    "\x1b[B",
    pasted(line),
    "\r",
  ]);
});

test("C-QUESTION-03 confirms an unbroken run that Claude's editor breaks inside", async () => {
  expect(parseClaudeQuestionScreen(native("single-other-unbroken-native"), [note])).toMatchObject({
    other: rowsOf(link, editorRowCells, editorRowCells).join("\n"),
  });
  expect(await answerNoteWith(link, "single-other-unbroken-native")).toEqual([
    "\x1b[B",
    pasted(link),
    "\r",
  ]);
});

test("C-QUESTION-03 reads a review that breaks an unbroken answer inside it", () => {
  const [first, ...rest] = rowsOf(link, reviewFirstRowCells, reviewRowCells);
  const summary = ["● Which test color?", "→ Amber", "● Which test note?", `→ ${first}`, ...rest];
  expect(
    parseClaudeQuestionScreen(native("grouped-review-unbroken-native"), [color, note]),
  ).toEqual({
    kind: "review",
    cursor: 0,
    summary: summary.join("\n"),
  });
  const expected = `● Which test color? → Amber\n● Which test note? → ${link}`;
  expect(claudeDrawnTextMatcher(expected)(summary.join("\n"))).toBe(true);
});

test("C-QUESTION-03 submits unbroken text that the editor and the review break inside", async () => {
  const request = registry().publish("native", "blocking", definitions)!;
  const [color, features] = request.questions;
  const answers = validateQuestionAnswers(request, [
    { questionId: color!.id, text: link },
    { questionId: features!.id, optionIds: features!.options.map((option) => option.id) },
  ]);
  const drawn = rowsOf(link, editorRowCells, editorRowCells).join("\n     ");
  const reviewed = rowsOf(link, reviewFirstRowCells, reviewRowCells).join("\n   ");
  const { io, writes } = scriptedQuestionIo(
    fixture("questions"),
    groupedTextAnswerFrames(drawn, reviewed),
  );
  await answerClaudeQuestions(request, answers, io);
  expect(writes).toEqual([
    "\x1b[B",
    "\x1b[B",
    pasted(link),
    "\r",
    " ",
    "\x1b[B",
    " ",
    "\x1b[B",
    "\x1b[B",
    "\r",
    "\r",
  ]);
});

test("C-QUESTION-03 confirms tabs that Claude's editor draws as spaces", async () => {
  const typed = parseClaudeQuestionScreen(native("single-other-tabs-native"), [note]);
  // Claude's cursor counts a tab as no cells, so it stops short of the drawn row's end.
  expect(typed).toMatchObject({ other: expect.stringMatching(/^col1 {4}col2 {4}col3 {20,}$/) });
  expect(await answerNoteWith("col1\tcol2\tcol3", "single-other-tabs-native")).toEqual([
    "\x1b[B",
    pasted("col1\tcol2\tcol3"),
    "\r",
  ]);
});

test.each([
  "\r\n",
  "\r",
])("C-QUESTION-03 pastes %j line endings as LF, which Claude keeps", async (ending) => {
  // Claude's editor would keep a pasted CRLF pair as CR.
  const writes = await answerNoteWith(
    `ELWOOD_NOTE_LINE1_x${ending}ELWOOD_NOTE_LINE2`,
    "single-other-two-lines-native",
  );
  expect(writes).toEqual(["\x1b[B", pasted("ELWOOD_NOTE_LINE1_x\nELWOOD_NOTE_LINE2"), "\r"]);
});
