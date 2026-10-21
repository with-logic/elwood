/** Native draft ownership is rechecked before question navigation (PRD §4). */
import { expect, test } from "vitest";
import { answerBlocking, answerQueued } from "../../../src/codex/questions/driver.ts";
import { matchesQuestion, questionView } from "../../../src/codex/questions/frame.ts";
import type { QuestionFrame, QuestionIo } from "../../../src/core/questions/adapter.ts";
import { questionAnswerFailed } from "../../../src/core/questions/errors.ts";
import { editorFrame } from "./editor-fixtures.ts";
import { captured, definitions, frame, scriptedIo } from "./helpers.ts";

function replaced(io: QuestionIo, replacement: QuestionFrame): QuestionIo {
  return {
    ...io,
    write: (_input, expected) => {
      if (expected(replacement)) throw new Error("Human draft received navigation");
      throw questionAnswerFailed();
    },
  };
}
const modal = definitions("blocking-records.json");
const queued = definitions("async-records.json");
const first = captured("blocking-modal-first.txt");
const notes = frame(
  first.text.replace(
    "tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt",
    "› Human notes\n\n  tab or esc to clear notes | enter to submit answer",
  ),
);
test.each([
  0, 1,
])("human notes opened before modal navigation are preserved (%i)", async (index) => {
  const scripted = scriptedIo(first, []);
  await expect(
    answerBlocking(
      modal,
      [{ optionIndexes: [index] }, { optionIndexes: [0] }],
      replaced(scripted.io, notes),
      () => {},
    ),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(scripted.writes).toEqual([]);
});
const choice = captured("async-editor-first.txt");
const otherDraft = editorFrame(
  frame(
    choice.text
      .replace("  › 1. Amber", "    1. Amber")
      .replace("    3. Other", "  › 3. Human reason"),
  ),
  { editorLine: "  › 3. Human reason", cursorLineBefore: "  › 3. Human reason", dimmed: false },
);
test("queued listed-option answers preserve a human Other draft", async () => {
  expect(matchesQuestion(questionView(otherDraft)!, queued[0]!)).toBe(true);
  const scripted = scriptedIo(otherDraft, []);
  await expect(
    answerQueued(queued, { optionIndexes: [0] }, 0, scripted.io, () => {}),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(scripted.writes).toEqual([]);
});
test("queued navigation rechecks the human Other draft", async () => {
  const emptyOther = editorFrame(frame(otherDraft.text.replace("Human reason", "Other")), {
    editorLine: "  › 3. Other",
    cursorLineBefore: "  › 3. ",
    dimmed: true,
  });
  expect(matchesQuestion(questionView(emptyOther)!, queued[0]!)).toBe(true);
  expect(matchesQuestion(questionView(otherDraft)!, queued[0]!)).toBe(true);
  const scripted = scriptedIo(emptyOther, []);
  await expect(
    answerQueued(queued, { optionIndexes: [1] }, 0, replaced(scripted.io, otherDraft), () => {}),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(scripted.writes).toEqual([]);
});
