/** Answer arrays must be dense and bounded before native writes (PRD §4). */
import { expect, test } from "vitest";
import { questionError } from "../../../src/core/questions/errors.ts";
import type { ElwoodQuestionAnswer } from "../../../src/core/questions/types.ts";
import { questionTimeout, validateQuestionAnswers } from "../../../src/core/questions/validate.ts";
import { definitions, registry } from "./helpers.ts";

const request = registry().publish("native", "queued", [definitions[0]!])!;
const question = request.questions[0]!;
const invalid = expect.objectContaining({ code: "invalid_question_answer" });

test.each(["hole", "inherited", "undefined", "number"])("rejects %s option IDs", (kind) => {
  const ids: string[] = [question.options[0]!.id];
  if (kind === "hole" || kind === "inherited") delete ids[0];
  if (kind === "inherited") {
    const prototype = Object.create(Array.prototype) as Record<string, unknown>;
    prototype["0"] = question.options[0]!.id;
    Object.setPrototypeOf(ids, prototype);
  }
  if (kind === "undefined") Reflect.set(ids, "0", undefined);
  if (kind === "number") Reflect.set(ids, "0", 1);
  expect(() =>
    validateQuestionAnswers(request, [{ questionId: question.id, optionIds: ids }]),
  ).toThrow(invalid);
});

test.each([
  null,
  "not an array",
])("rejects non-array option IDs %s even with alternative text", (optionIds) => {
  const answer = { questionId: question.id, optionIds: [question.options[0]!.id], text: "answer" };
  Reflect.set(answer, "optionIds", optionIds);
  expect(() => validateQuestionAnswers(request, [answer])).toThrow(invalid);
});

test("bounds the aggregate UTF-8 answer size before sanitization", () => {
  const textRequest = registry().publish("text", "queued", [definitions[0]!, definitions[0]!])!;
  const text = "é".repeat(2 * 1024 * 1024);
  const answers = textRequest.questions.map(({ id }) => ({ questionId: id, text }));
  expect(validateQuestionAnswers(textRequest, answers)).toEqual([
    { optionIndexes: [], text },
    { optionIndexes: [], text },
  ]);
  expect(() =>
    validateQuestionAnswers(textRequest, [answers[0]!, { ...answers[1]!, text: `${text}a` }]),
  ).toThrow(invalid);
});

test("private failures retain typed codes and optional diagnostic details", () => {
  const details = { source: "native" };
  const error = questionError("question_answer_failed", "not accepted", details);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ message: "not accepted", code: "question_answer_failed" });
  expect(error.details).toBe(details);
});

test.each([
  null,
  false,
  1,
  "options",
  1n,
  Symbol("options"),
  () => {},
])("rejects non-object answer options %s", (options) => {
  expect(() => Reflect.apply(questionTimeout, undefined, [options])).toThrow(invalid);
});

test("rejects null timeout instead of treating it as omitted", () => {
  const options = { timeoutMs: 25 };
  Reflect.set(options, "timeoutMs", null);
  expect(() => questionTimeout(options)).toThrow(invalid);
});

test("retains omitted and positive finite timeout behavior", () => {
  expect(questionTimeout({})).toBe(20_000);
  expect(questionTimeout({ timeoutMs: 0.5 })).toBe(0.5);
  expect(questionTimeout({ timeoutMs: Number.MAX_SAFE_INTEGER })).toBe(Number.MAX_SAFE_INTEGER);
});

test.each(["\uD800", "\uDC00"])("rejects ill-formed UTF-16 text %s before PTY encoding", (text) => {
  expect(() => validateQuestionAnswers(request, [{ questionId: question.id, text }])).toThrow(
    invalid,
  );
});

test("preserves a well-formed emoji answer", () => {
  expect(validateQuestionAnswers(request, [{ questionId: question.id, text: "😀" }])).toEqual([
    { optionIndexes: [], text: "😀" },
  ]);
});

test("validates and returns the same once-read text snapshot", () => {
  let reads = 0;
  const answer = {
    questionId: question.id,
    get text() {
      reads++;
      return reads <= 2 ? "safe" : "a".repeat(8 * 1024 * 1024 + 1);
    },
  };
  const result = validateQuestionAnswers(request, [answer]);
  expect(result[0]).toEqual({ optionIndexes: [], text: "safe" });
  expect(reads).toBe(1);
});

test("snapshots answer fields and selected values once", () => {
  const reads = { questionId: 0, optionIds: 0, text: 0, selected: 0 };
  const ids = [question.options[0]!.id];
  Object.defineProperty(ids, "0", {
    get() {
      reads.selected++;
      return question.options[0]!.id;
    },
  });
  const answer = {
    get questionId() {
      reads.questionId++;
      return question.id;
    },
    get optionIds() {
      reads.optionIds++;
      return ids;
    },
  };
  Object.defineProperty(answer, "text", {
    get() {
      reads.text++;
      return undefined;
    },
  });
  expect(validateQuestionAnswers(request, [answer])).toEqual([{ optionIndexes: [0] }]);
  expect(reads).toEqual({ questionId: 1, optionIds: 1, text: 1, selected: 1 });
});

test("rejects a hole in an otherwise complete answer array", () => {
  const answers = [{ questionId: question.id, text: "safe" }];
  delete answers[0];
  expect(() => validateQuestionAnswers(request, answers)).toThrow(invalid);
});

test("snapshots indexed answers independently of an array iterator", () => {
  const answers = [{ questionId: question.id, text: "safe" }];
  Object.defineProperty(answers, Symbol.iterator, { value: () => [][Symbol.iterator]() });
  expect(validateQuestionAnswers(request, answers)).toEqual([{ optionIndexes: [], text: "safe" }]);
});

test("rejects a non-array complete-answer payload", () => {
  expect(() => Reflect.apply(validateQuestionAnswers, undefined, [request, null])).toThrow(invalid);
});

test("rejects non-string answer text with a typed boundary error", () => {
  const answer = { questionId: question.id, text: "safe" };
  Reflect.set(answer, "text", 7);
  expect(() => validateQuestionAnswers(request, [answer])).toThrow(invalid);
});

test("rejects inherited answers in sparse complete batches", () => {
  const inherited = [{ questionId: question.id, text: "safe" }];
  const answers = new Array<ElwoodQuestionAnswer>(1);
  Object.setPrototypeOf(answers, inherited);
  expect(() => validateQuestionAnswers(request, answers)).toThrow(invalid);
});

test("rejects an own answer slot containing undefined", () => {
  const answers = [{ questionId: question.id, text: "safe" }];
  Reflect.set(answers, "0", undefined);
  expect(() => validateQuestionAnswers(request, answers)).toThrow(invalid);
});
