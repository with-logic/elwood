/** Complete native answer validation before any physical write (PRD §4). */
import { describe, expect, test } from "vitest";
import type { ElwoodQuestionAnswer } from "../../../src/core/questions/types.ts";
import {
  questionTimeoutMs,
  validateQuestionAnswers,
} from "../../../src/core/questions/validate.ts";
import { definitions, registry } from "./helpers.ts";

const request = registry().publish("a", "blocking", definitions)!;
const [color, features] = request.questions;
const valid: readonly ElwoodQuestionAnswer[] = [
  { questionId: color!.id, optionIds: [color!.options[1]!.id] },
  { questionId: features!.id, optionIds: features!.options.map((option) => option.id) },
];
describe("private answer validation", () => {
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
    expect(questionTimeoutMs()).toBe(20000);
    expect(questionTimeoutMs({ timeoutMs: 25 })).toBe(25);
  });
  test.each([
    0,
    -1,
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ])("rejects invalid timeout %s", (timeoutMs) => {
    expect(() => questionTimeoutMs({ timeoutMs })).toThrow(
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
        valid[0]!,
        {
          questionId: features!.id,
          optionIds: [features!.options[0]!.id, features!.options[0]!.id],
        },
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
    ])!;
    expect(
      validateQuestionAnswers(note, [{ questionId: note.questions[0]!.id, text: "note" }]),
    ).toEqual([{ optionIndexes: [], text: "note" }]);
    expect(() =>
      validateQuestionAnswers(note, [{ questionId: note.questions[0]!.id, optionIds: ["x"] }]),
    ).toThrow(expect.objectContaining({ code: "invalid_question_answer" }));
  });
  test("rejects even valid option IDs when the provider permits no selection", () => {
    const none = registry().publish("none", "queued", [{ ...definitions[0]!, selection: "none" }])!;
    const question = none.questions[0]!;
    expect(() =>
      validateQuestionAnswers(none, [
        {
          questionId: question.id,
          optionIds: [question.options[0]!.id],
        },
      ]),
    ).toThrow(expect.objectContaining({ code: "invalid_question_answer" }));
  });
  test("preserves selected options alongside additional text", () => {
    const additional = registry().publish("additional", "queued", [
      { ...definitions[0]!, textMode: "additional" },
    ])!;
    const question = additional.questions[0]!;
    expect(
      validateQuestionAnswers(additional, [
        {
          questionId: question.id,
          optionIds: [question.options[1]!.id],
          text: "additional note",
        },
      ]),
    ).toEqual([{ optionIndexes: [1], text: "additional note" }]);
  });
});
