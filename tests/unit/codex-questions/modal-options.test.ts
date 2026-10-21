/** Native modal None, text alone and choice-plus-notes mapping (PRD §7A.5). */
import { expect, test } from "vitest";
import type { QuestionFrame } from "../../../src/core/questions/adapter.ts";
import { validateQuestionAnswers } from "../../../src/core/questions/validate.ts";
import { captured, frame, harness, records, scriptedIo } from "./helpers.ts";

function notes(source: QuestionFrame, text: string) {
  return frame(
    source.text.replace(
      /tab to add notes \| enter to submit (answer|all) \| ←\/→ to navigate questions \| esc to interrupt/,
      `› ${text}\n\n  tab or esc to clear notes | enter to submit $1`,
    ),
  );
}
test("C-QUESTION-01 C-QUESTION-02 exposes and answers native None alone and named choice plus notes", async () => {
  const h = harness();
  const native = records("blocking-records.json")[0] as {
    readonly payload: { readonly call_id: string };
  };
  h.observe(native);
  const first = captured("blocking-modal-first.txt");
  h.adapter.render(first);
  const request = h.registry.list()[0]!;
  const color = request.questions[0]!;
  const note = request.questions[1]!;
  expect(color.options.map((option) => option.label)).toEqual([
    "Amber",
    "Blue",
    "None of the above",
  ]);
  expect(color.options[2]!.id).not.toBe("None of the above");
  const answers = validateQuestionAnswers(request, [
    { questionId: color.id, optionIds: [color.options[2]!.id] },
    { questionId: note.id, optionIds: [note.options[0]!.id], text: "Detail" },
  ]);
  const blue = frame(
    first.text.replace("  › 1. Amber", "    1. Amber").replace("    2. Blue", "  › 2. Blue"),
  );
  const none = frame(
    first.text
      .replace("  › 1. Amber", "    1. Amber")
      .replace("    3. None of the above", "  › 3. None of the above"),
  );
  const second = captured("blocking-modal-second.txt");
  const scripted = scriptedIo(first, [
    { input: "\x1b[B", next: blue },
    { input: "\x1b[B", next: none },
    { input: "\t", next: notes(none, "Add notes") },
    { input: "\r", next: second },
    { input: "\t", next: notes(second, "Add notes") },
    { input: "\x1b[200~Detail\x1b[201~", next: notes(second, "Detail") },
    { input: "\r" },
  ]);
  await h.adapter.answer(request, answers, scripted.io);
  expect(scripted.writes).toEqual([
    "\x1b[B",
    "\x1b[B",
    "\t",
    "\r",
    "\t",
    "\x1b[200~Detail\x1b[201~",
    "\r",
  ]);
  h.observe({
    payload: {
      type: "function_call_output",
      call_id: native.payload.call_id,
      output: JSON.stringify({
        answers: {
          color: { answers: ["None of the above"] },
          note: { answers: ["Standard", "user_note: Detail"] },
        },
      }),
    },
  });
  expect(h.registry.list()).toEqual([]);
  expect(h.events.at(-1)).toMatchObject({ phase: "closed", reason: "answered" });
});
test("C-QUESTION-02 text alone targets the real native modal alternative", () => {
  const h = harness();
  h.observe(records("blocking-records.json")[0]);
  h.adapter.render(captured("blocking-modal-first.txt"));
  const request = h.registry.list()[0]!;
  const answer = validateQuestionAnswers(
    request,
    request.questions.map((question) => ({ questionId: question.id, text: "Detail" })),
  );
  expect(answer).toEqual([
    { optionIndexes: [], text: "Detail" },
    { optionIndexes: [], text: "Detail" },
  ]);
  expect(
    request.questions.every((question) => question.options.at(-1)?.label === "None of the above"),
  ).toBe(true);
});
