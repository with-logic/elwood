/** Native editor races stop before speculative question input (PRD §7A.5). */
import { expect, test } from "vitest";
import {
  answerBlocking,
  answerQueued,
  failedQuestion,
} from "../../../src/codex/questions/driver.ts";
import { questionCall } from "../../../src/codex/questions/records.ts";
import type { QuestionFrame, QuestionIo } from "../../../src/core/questions/adapter.ts";
import { captured, frame, harness, records, scriptedIo } from "./helpers.ts";

function definitions(name: string) {
  const record = records(name)[0] as { readonly payload: Record<string, unknown> };
  return questionCall(record.payload)!.questions.map((question) => question.definition);
}
const queued = definitions("async-records.json");
const modal = definitions("blocking-records.json");
function raced(io: QuestionIo, target: string, replacement: QuestionFrame): QuestionIo {
  return {
    ...io,
    write: async (input, expected) => {
      if (input !== target) return await io.write(input, expected);
      if (expected(replacement)) throw new Error("Changed native editor admitted unsafe input");
      throw failedQuestion();
    },
  };
}
test("C-QUESTION-02 unrelated same-count queued pages receive no navigation", async () => {
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
test("C-QUESTION-02 quoted expected text below a foreign heading grants no answer authority", async () => {
  const text = captured("async-editor-first.txt")
    .text.replaceAll(queued[0]!.prompt, "Foreign heading")
    .replace("  enter submit", `  ${queued[0]!.prompt}\n\n  enter submit`);
  const scripted = scriptedIo(frame(text), []);
  await expect(
    answerQueued(queued, { optionIndexes: [0] }, 0, scripted.io, () => {}),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(scripted.writes).toEqual([]);
});
test.each([
  frame("unrelated dialog"),
  captured("async-editor-blue.txt"),
])("C-QUESTION-02 selected choice changes before final Enter receive no submission", async (replacement) => {
  const scripted = scriptedIo(captured("async-editor-first.txt"), []);
  await expect(
    answerQueued(
      queued,
      { optionIndexes: [0] },
      0,
      raced(scripted.io, "\r", replacement),
      () => {},
    ),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(scripted.writes).toEqual([]);
});
test("C-QUESTION-02 staged free text changes before Enter receive no submission", async () => {
  const empty = captured("async-after-first.txt");
  const typed = captured("async-editor-note.txt");
  const scripted = scriptedIo(empty, [{ input: "\x1b[200~ELWOOD_NOTE_74\x1b[201~", next: typed }]);
  const changed = frame(typed.text.replace("  ELWOOD_NOTE_74", "  Changed draft"));
  await expect(
    answerQueued(
      [queued[1]!],
      { optionIndexes: [], text: "ELWOOD_NOTE_74" },
      0,
      raced(scripted.io, "\r", changed),
      () => {},
    ),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(scripted.writes).toHaveLength(1);
});
test("C-QUESTION-02 a modal notes page already owned by a human receives no input", async () => {
  const notes = frame(
    captured("blocking-modal-first.txt").text.replace(
      "tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt",
      "› Add notes\n\n  tab or esc to clear notes | enter to submit answer",
    ),
  );
  const scripted = scriptedIo(notes, []);
  await expect(
    answerBlocking(modal, [{ optionIndexes: [0] }, { optionIndexes: [0] }], scripted.io, () => {}),
  ).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(scripted.writes).toEqual([]);
});
test("C-QUESTION-01 queued and modal requests coexist without merging native acceptance units", () => {
  const h = harness();
  const native = records("async-records.json");
  h.observe(native[0]);
  h.observe(native[1]);
  h.adapter.render(captured("async-editor-first.txt"));
  h.observe(records("blocking-records.json")[0]);
  h.adapter.render(captured("blocking-modal-first.txt"));
  expect(h.registry.list()).toHaveLength(3);
  h.observe(native[3]);
  h.adapter.render(captured("async-after-first.txt"));
  expect(h.registry.list()).toHaveLength(2);
});
test("C-QUESTION-02 disposal after an uncertain Enter releases suppression without further writes", async () => {
  const h = harness();
  const native = records("async-records.json");
  h.observe(native[0]);
  h.observe(native[1]);
  h.adapter.render(captured("async-editor-first.txt"));
  const scripted = scriptedIo(captured("async-editor-first.txt"), [{ input: "\r" }]);
  let disposed = false;
  await h.adapter.answer(h.registry.list()[0]!, [{ optionIndexes: [0] }], {
    ...scripted.io,
    frame: () => (disposed ? undefined : scripted.io.frame()),
  });
  disposed = true;
  scripted.controller.abort();
  h.adapter.render(captured("async-after-first.txt"));
  expect(h.registry.list()).toHaveLength(1);
  expect(scripted.writes).toEqual(["\r"]);
});
test("C-QUESTION-02 a live composer before committed answer acknowledgement preserves the submitting request", async () => {
  const h = harness();
  const native = records("async-records.json");
  h.observe(native[0]);
  h.observe(native[1]);
  h.adapter.render(captured("async-badge.txt"));
  h.observe(native[4]); // The other independent native question is already answered.
  const single = frame(captured("async-editor-first.txt").text.replace("  1 of 2\n", ""));
  h.adapter.render(single);
  const composer = {
    ...frame("› Ask Codex to do anything\n\n  GPT-6-Luna low"),
    cursorX: 2,
    cursorY: 0,
    cursorRow: 0,
  };
  const scripted = scriptedIo(single, [{ input: "\r", next: composer }]);
  await h.adapter.answer(h.registry.list()[0]!, [{ optionIndexes: [0] }], scripted.io);
  h.adapter.render(composer);
  expect(h.registry.list()).toHaveLength(1);
  h.observe(native[3]);
  expect(h.registry.list()).toEqual([]);
  expect(h.events.at(-1)).toMatchObject({ phase: "closed", reason: "answered" });
});
