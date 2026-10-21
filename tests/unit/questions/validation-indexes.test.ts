/** Validation indexes questions and native options without repeated linear scans (PRD §4). */
import { expect, test } from "vitest";
import type { ElwoodQuestionRequest } from "../../../src/core/questions/types.ts";
import { validateQuestionAnswers } from "../../../src/core/questions/validate.ts";
import { definitions } from "./helpers.ts";

const count = 1_000;
test("question ID reads grow linearly for a reordered complete batch", () => {
  let idReads = 0;
  const request: ElwoodQuestionRequest = {
    id: "request",
    agent: "claude",
    delivery: "queued",
    questions: Array.from({ length: count }, (_, index) => ({
      ...definitions[0]!,
      options: [],
      get id() {
        idReads++;
        return `question-${index}`;
      },
    })),
  };
  const answers = Array.from({ length: count }, (_, index) => ({
    questionId: `question-${count - index - 1}`,
    text: `text-${count - index - 1}`,
  }));
  const result = validateQuestionAnswers(request, answers);
  expect(idReads).toBeLessThanOrEqual(2 * count);
  expect(result).toEqual(
    Array.from({ length: count }, (_, index) => ({
      optionIndexes: [],
      text: `text-${index}`,
    })),
  );
});

test("option ID reads grow linearly for a large reverse-ordered selection", () => {
  let idReads = 0;
  const request: ElwoodQuestionRequest = {
    id: "request",
    agent: "claude",
    delivery: "queued",
    questions: [
      {
        ...definitions[1]!,
        id: "question",
        options: Array.from({ length: count }, (_, index) => ({
          get id() {
            idReads++;
            return `option-${index}`;
          },
          label: `Choice ${index}`,
        })),
      },
    ],
  };
  const result = validateQuestionAnswers(request, [
    {
      questionId: "question",
      optionIds: Array.from({ length: count }, (_, index) => `option-${count - index - 1}`),
    },
  ]);
  expect(idReads).toBe(count);
  expect(result).toEqual([{ optionIndexes: Array.from({ length: count }, (_, index) => index) }]);
});
