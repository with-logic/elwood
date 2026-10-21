/** Complete native answer validation before any physical write (C-QUESTION-02). */
import { describe, expect, test } from "vitest";
import type { ElwoodQuestionAnswer } from "../../../src/core/questions/types.ts";
import { questionTimeout, validateQuestionAnswers } from "../../../src/core/questions/validate.ts";
import { definitions, registry } from "./helpers.ts";

const request = registry().publish("a", "blocking", definitions);
const [color, features] = request.questions;
const valid: readonly ElwoodQuestionAnswer[] = [
  { questionId: color!.id, optionIds: [color!.options[1]!.id] },
  { questionId: features!.id, optionIds: features!.options.map((option) => option.id) },
];
describe("C-QUESTION-02 validation", () => {
  test("normalizes reordered complete answers and safe multiline alternative text", () => {
    expect(validateQuestionAnswers(request, [valid[1]!, valid[0]!])).toEqual([
      { optionIndexes: [1] },
      { optionIndexes: [0, 1] },
    ]);
    expect(
      validateQuestionAnswers(request, [
        { questionId: color!.id, text: "hello\nworld" },
        valid[1]!,
      ])[0],
    ).toEqual({ optionIndexes: [], text: "hello\nworld" });
    expect(
      validateQuestionAnswers(request, [
        valid[0]!,
        {
          questionId: features!.id,
          optionIds: features!.options.map((option) => option.id).reverse(),
        },
      ])[1],
    ).toEqual({ optionIndexes: [0, 1] });
    expect(questionTimeout()).toBe(20000);
    expect(questionTimeout({ timeoutMs: 25 })).toBe(25);
  });
  test.each([
    0,
    -1,
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ])("rejects invalid timeout %s", (timeoutMs) => {
    expect(() => questionTimeout({ timeoutMs })).toThrow(
      expect.objectContaining({ code: "invalid_question_answer" }),
    );
  });
  test.each(
    [
      [],
      [valid[0]!, valid[0]!],
      [{ questionId: "foreign" }, valid[1]!],
      [{ questionId: color!.id }, valid[1]!],
      [{ questionId: color!.id, optionIds: ["unknown"] }, valid[1]!],
      [{ questionId: color!.id, optionIds: color!.options.map((option) => option.id) }, valid[1]!],
      [
        { questionId: color!.id, optionIds: [color!.options[0]!.id, color!.options[0]!.id] },
        valid[1]!,
      ],
      [{ questionId: color!.id, text: "\x1b[201~\r" }, valid[1]!],
      [{ questionId: color!.id, text: "   " }, valid[1]!],
      [{ questionId: color!.id, text: "text", optionIds: [color!.options[0]!.id] }, valid[1]!],
      [valid[0]!, { questionId: features!.id, text: "text" }],
    ].map((answers) => ({ answers })),
  )("rejects incomplete, duplicate, foreign and unsafe batch %#", ({ answers }) => {
    expect(() => validateQuestionAnswers(request, answers)).toThrow(
      expect.objectContaining({ code: "invalid_question_answer" }),
    );
  });
  test("supports text-only and additional-note provider capabilities", () => {
    const note = registry().publish("b", "queued", [
      { ...definitions[0]!, selection: "none", options: [], textMode: "additional" },
    ]);
    expect(
      validateQuestionAnswers(note, [{ questionId: note.questions[0]!.id, text: "note" }]),
    ).toEqual([{ optionIndexes: [], text: "note" }]);
    expect(() =>
      validateQuestionAnswers(note, [{ questionId: note.questions[0]!.id, optionIds: ["x"] }]),
    ).toThrow();
  });
});
