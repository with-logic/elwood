/** Reject malformed singleton queue batches before native routing (PRD §4). */
import { expect, test } from "vitest";
import type { ValidatedQuestionAnswer } from "../../../src/core/questions/validate.ts";
import { harness } from "./adapter-helpers.ts";
import { captured, records, scriptedIo } from "./helpers.ts";

const unreadable = Object.defineProperty(new Array<ValidatedQuestionAnswer>(2), "0", {
  get: () => {
    throw new Error("Arity rejection must precede reading an answer");
  },
});
const batches: readonly {
  readonly label: string;
  readonly answers: readonly ValidatedQuestionAnswer[];
}[] = [
  { label: "empty", answers: [] },
  { label: "multiple", answers: [{ optionIndexes: [0] }, { optionIndexes: [0] }] },
  { label: "sparse", answers: new Array<ValidatedQuestionAnswer>(1) },
  { label: "unreadable multiple", answers: unreadable },
];
test.each(batches)("rejects a $label direct queued answer batch without writes", async ({
  answers,
}) => {
  const h = harness();
  h.observe(records("async-records.json")[1]);
  h.adapter.render(captured("async-badge.txt"));
  const request = h.registry.list()[0]!;
  const scripted = scriptedIo(captured("async-editor-first.txt"), []);
  await expect(h.adapter.answer(request, answers, scripted.io)).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  expect(scripted.writes).toEqual([]);
  expect(h.registry.get(request.id)).toBe(request);
});
