/** Invalid request-bound Claude answer batches fail before native IO (PRD §4). */
import { expect, test, vi } from "vitest";
import { answerClaudeQuestions } from "../../../src/claude/questions/answer.ts";
import type { QuestionIo } from "../../../src/core/questions/adapter.ts";
import type { ValidatedQuestionAnswer } from "../../../src/core/questions/validate.ts";
import { definitions, registry } from "./helpers.ts";

const request = registry().publish("native", "blocking", definitions)!;
const valid = [{ optionIndexes: [1] }, { optionIndexes: [0, 1] }];
const sparse = new Array<ValidatedQuestionAnswer>(2);
sparse[0] = valid[0]!;

test.each([
  ["empty", []],
  ["missing question", valid.slice(0, 1)],
  ["extra question", [...valid, valid[0]]],
  ["missing batch slot", sparse],
  ["undefined batch slot", [undefined, valid[1]]],
  ["negative option", [{ optionIndexes: [-1] }, valid[1]]],
  ["late out-of-range option", [valid[0], { optionIndexes: [2] }]],
  ["fractional option", [{ optionIndexes: [0.5] }, valid[1]]],
  ["missing option slot", [{ optionIndexes: new Array<number>(1) }, valid[1]]],
  ["no single-choice target", [{ optionIndexes: [] }, valid[1]]],
])("rejects %s before any native IO", async (_name, answers) => {
  const native = vi.fn(() => {
    throw new Error("Invalid batch reached native IO");
  });
  const io: QuestionIo = {
    signal: new AbortController().signal,
    frame: native,
    wait: native,
    write: native,
  };
  await expect(
    Reflect.apply(answerClaudeQuestions, undefined, [request, answers, io]),
  ).rejects.toMatchObject({
    code: "question_answer_failed",
  });
  expect(native).not.toHaveBeenCalled();
});
