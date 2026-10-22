/** Invalid request-bound Claude answer batches fail before native IO (PRD §4). */
import { expect, test, vi } from "vitest";
import { answerClaudeQuestions } from "../../../src/claude/questions/answer.ts";
import type { QuestionIo } from "../../../src/core/questions/adapter.ts";
import { definitions, registry } from "./helpers.ts";

const request = registry().publish("native", "blocking", definitions)!;
test("out-of-range normalized options fail before any native IO", async () => {
  const answers = [{ optionIndexes: [1] }, { optionIndexes: [2] }];
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
