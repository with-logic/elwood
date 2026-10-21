/** Exact metadata and retained-state bounds for the PRD §4 adapter boundary. */
import { expect, test } from "vitest";
import {
  checkQuestionArguments,
  checkQuestionInput,
  QuestionBudget,
  QuestionLimitError,
} from "../../../src/codex/questions/limits.ts";

const mib = 1024 * 1024;
test("decoded metadata includes UTF-8 identity bytes at its inclusive limit", () => {
  const value = [{ title: "Q" }];
  const overhead = Buffer.byteLength(JSON.stringify(["", value]));
  const identity = "é".repeat((mib - overhead) / 2) + "x".repeat((mib - overhead) % 2);
  expect(Buffer.byteLength(JSON.stringify([identity, value]))).toBe(mib);
  expect(() => checkQuestionInput(value, identity)).not.toThrow();
  expect(() => checkQuestionInput(value, `${identity}x`)).toThrow(QuestionLimitError);
  expect(() => checkQuestionInput(Array.from({ length: 256 }, () => null))).not.toThrow();
  expect(() => checkQuestionInput(Array.from({ length: 257 }, () => null))).toThrow(
    QuestionLimitError,
  );
  expect(() => checkQuestionInput(1n)).toThrow(QuestionLimitError);
});
test("raw argument bytes count the native identity before JSON parsing", () => {
  expect(() => checkQuestionArguments("é".repeat(mib / 2 - 1), "é")).not.toThrow();
  expect(() => checkQuestionArguments("é".repeat(mib / 2), "x")).toThrow(QuestionLimitError);
  expect(() => checkQuestionArguments(undefined, undefined)).not.toThrow();
});
test("pending requests and their aggregate bytes have independent inclusive limits", () => {
  const budget = new QuestionBudget();
  budget.replace(256, mib);
  expect(() => budget.replace(257, 0)).toThrow(QuestionLimitError);
  expect(() => budget.replace(256, 1)).toThrow(QuestionLimitError);
  budget.replace(256, -1);
  expect(() => budget.replace(256, 1)).not.toThrow();
  budget.clear();
  expect(() => budget.replace(1, mib)).not.toThrow();
});
test("replay tombstones deduplicate and preserve a full 4096-identity history", () => {
  const budget = new QuestionBudget();
  expect(budget.hasRetired("0")).toBe(false);
  for (let index = 0; index < 4096; index++) budget.retire(String(index));
  expect(budget.hasRetired("0")).toBe(true);
  expect(() => budget.retire("0")).not.toThrow();
  expect(() => budget.retire("4096")).toThrow(QuestionLimitError);
  budget.clear();
  expect(budget.hasRetired("0")).toBe(false);
  expect(() => budget.retire("4096")).not.toThrow();
});
test("retired UTF-8 identities accept exactly 1 MiB without evicting history", () => {
  const budget = new QuestionBudget();
  const key = "é".repeat(mib / 2);
  budget.retire(key);
  expect(() => budget.retire(key)).not.toThrow();
  expect(() => budget.retire("x")).toThrow(QuestionLimitError);
  expect(budget.hasRetired(key)).toBe(true);
  budget.clear();
  expect(() => budget.retire("x")).not.toThrow();
});
