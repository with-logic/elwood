/** Unsupported Codex selection modes fail at the driver boundary before IO (PRD §4). */
import { expect, test, vi } from "vitest";
import { answerBlocking, answerQueued } from "../../../src/codex/questions/driver.ts";
import type { QuestionIo } from "../../../src/core/questions/adapter.ts";
import type { QuestionDefinition } from "../../../src/core/questions/types.ts";
import { definitions } from "./helpers.ts";

test.each([
  { delivery: "queued", unsupportedQuestionIndex: 0 },
  { delivery: "queued", unsupportedQuestionIndex: 1 },
  { delivery: "blocking", unsupportedQuestionIndex: 0 },
  { delivery: "blocking", unsupportedQuestionIndex: 1 },
])("$delivery rejects unsupported question $unsupportedQuestionIndex before any IO", async ({
  delivery,
  unsupportedQuestionIndex,
}) => {
  const unexpectedIo = () => {
    throw new Error("Unsupported selection reached native IO");
  };
  const io: QuestionIo = {
    signal: new AbortController().signal,
    frame: vi.fn(unexpectedIo),
    wait: vi.fn(unexpectedIo),
    write: vi.fn(unexpectedIo),
  };
  const questions = definitions(
    delivery === "queued" ? "async-records.json" : "blocking-records.json",
  ).map(
    (question, questionIndex): QuestionDefinition => ({
      ...question,
      selection: questionIndex === unsupportedQuestionIndex ? "multiple" : question.selection,
    }),
  );
  const submitting = vi.fn();
  const pending =
    delivery === "queued"
      ? answerQueued(questions, { optionIndexes: [0] }, 0, io, submitting)
      : answerBlocking(
          questions,
          questions.map(() => ({ optionIndexes: [0] })),
          io,
          submitting,
        );
  await expect(pending).rejects.toMatchObject({ code: "question_answer_failed" });
  expect(io.frame).not.toHaveBeenCalled();
  expect(io.wait).not.toHaveBeenCalled();
  expect(io.write).not.toHaveBeenCalled();
  expect(submitting).not.toHaveBeenCalled();
});
