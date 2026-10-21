/** Native editor races stop before speculative question input (PRD §4). */
import { expect, test, vi } from "vitest";
import { answerBlocking, answerQueued } from "../../../src/codex/questions/driver.ts";
import { matchesQuestion, questionView } from "../../../src/codex/questions/frame.ts";
import type { QuestionFrame, QuestionIo } from "../../../src/core/questions/adapter.ts";
import { questionAnswerFailed } from "../../../src/core/questions/errors.ts";
import { editorFrame } from "./editor-fixtures.ts";
import { captured, definitions, frame, scriptedIo } from "./helpers.ts";

const queued = definitions("async-records.json");
const modal = definitions("blocking-records.json");
function raced(io: QuestionIo, target: string, replacement: QuestionFrame): QuestionIo {
  return {
    ...io,
    write: async (input, expected) => {
      if (input !== target) return await io.write(input, expected);
      if (expected(replacement)) throw new Error("Changed native editor admitted unsafe input");
      throw questionAnswerFailed();
    },
  };
}
test("unrelated same-count queued pages receive no navigation", async () => {
  const unknown = frame(
    captured("async-editor-first.txt").text.replaceAll(
      queued[0]!.prompt,
      "Unrelated native question",
    ),
  );
  const scripted = scriptedIo(unknown, []);
  await expect(
    answerQueued(queued, { optionIndexes: [], text: "Mine" }, 1, scripted.io, () => {}),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(scripted.writes).toEqual([]);
});
test.each([
  frame("unrelated dialog"),
  captured("async-editor-blue.txt"),
])("selected choice changes before final Enter receive no submission", async (replacement) => {
  const scripted = scriptedIo(captured("async-editor-first.txt"), []);
  const submitting = vi.fn();
  await expect(
    answerQueued(
      queued,
      { optionIndexes: [0] },
      0,
      raced(scripted.io, "\r", replacement),
      submitting,
    ),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(scripted.writes).toEqual([]);
  expect(submitting).not.toHaveBeenCalled();
});
test("staged free text changes before Enter receive no submission", async () => {
  const empty = editorFrame(captured("async-after-first.txt"), {
    editorLine: "  Type your answer",
    cursorLineBefore: "  ",
    dimmed: true,
  });
  const typed = editorFrame(captured("async-editor-note.txt"), {
    editorLine: "  ELWOOD_NOTE_74",
    cursorLineBefore: "  ELWOOD_NOTE_74",
    dimmed: false,
  });
  const scripted = scriptedIo(empty, [{ input: "\x1b[200~ELWOOD_NOTE_74\x1b[201~", next: typed }]);
  const changed = editorFrame(frame(typed.text.replace("  ELWOOD_NOTE_74", "  Changed draft")), {
    editorLine: "  Changed draft",
    cursorLineBefore: "  Changed draft",
    dimmed: false,
  });
  const submitting = vi.fn();
  await expect(
    answerQueued(
      [queued[1]!],
      { optionIndexes: [], text: "ELWOOD_NOTE_74" },
      0,
      raced(scripted.io, "\r", changed),
      submitting,
    ),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(scripted.writes).toHaveLength(1);
  expect(submitting).not.toHaveBeenCalled();
});

test("a human edit immediately before paste preserves the editor without submission", async () => {
  const empty = editorFrame(captured("async-after-first.txt"), {
    editorLine: "  Type your answer",
    cursorLineBefore: "  ",
    dimmed: true,
  });
  const human = editorFrame(frame(empty.text.replace("Type your answer", "Human draft")), {
    editorLine: "  Human draft",
    cursorLineBefore: "  Human draft",
    dimmed: false,
  });
  expect(matchesQuestion(questionView(human)!, queued[1]!)).toBe(true);
  const scripted = scriptedIo(empty, []);
  const submitting = vi.fn();
  await expect(
    answerQueued(
      [queued[1]!],
      { optionIndexes: [], text: "Mine" },
      0,
      raced(scripted.io, "\x1b[200~Mine\x1b[201~", human),
      submitting,
    ),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(scripted.writes).toEqual([]);
  expect(submitting).not.toHaveBeenCalled();
});

test("a refused final modal Enter reports no submission", async () => {
  const first = frame(
    captured("blocking-modal-first.txt").text.replace("Question 1/2", "Question 1/1"),
  );
  const notes = editorFrame(
    frame(
      first.text.replace(
        "  tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt",
        "  › Add notes\n\n  tab or esc to clear notes | enter to submit answer",
      ),
    ),
    { editorLine: "  › Add notes", cursorLineBefore: "  › ", dimmed: true },
  );
  const scripted = scriptedIo(first, [{ input: "\t", next: notes }]);
  const submitting = vi.fn();
  await expect(
    answerBlocking(
      [modal[0]!],
      [{ optionIndexes: [0] }],
      raced(scripted.io, "\r", frame("unrelated dialog")),
      submitting,
    ),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(scripted.writes).toEqual(["\t"]);
  expect(submitting).not.toHaveBeenCalled();
});
