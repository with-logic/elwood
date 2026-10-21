/** Impossible selection counts reject before traversing native or supplied IDs (PRD §4). */
import { expect, test } from "vitest";
import type { ElwoodQuestionRequest } from "../../../src/core/questions/types.ts";
import { validateQuestionAnswers } from "../../../src/core/questions/validate.ts";
import { definitions } from "./helpers.ts";

test.each([
  { selection: "multiple", selectedCount: 1_000_000 },
  { selection: "single", selectedCount: 2 },
  { selection: "none", selectedCount: 1 },
] as const)("rejects impossible $selection counts before reading any option IDs", ({
  selection,
  selectedCount,
}) => {
  let nativeIdReads = 0;
  let selectedIdReads = 0;
  const request: ElwoodQuestionRequest = {
    id: "request",
    agent: "claude",
    delivery: "queued",
    questions: [
      {
        ...definitions[0]!,
        id: "question",
        selection,
        options: Array.from({ length: 2 }, (_, index) => ({
          get id() {
            nativeIdReads++;
            return `option-${index}`;
          },
          label: `Choice ${index}`,
        })),
      },
    ],
  };
  const ids = new Array<string>(selectedCount);
  Object.defineProperty(ids, "0", {
    get() {
      selectedIdReads++;
      return "option-0";
    },
  });
  expect(() =>
    validateQuestionAnswers(request, [{ questionId: "question", optionIds: ids }]),
  ).toThrow(expect.objectContaining({ code: "invalid_question_answer" }));
  expect(nativeIdReads).toBe(0);
  expect(selectedIdReads).toBe(0);
});
