/** Native question identity and display capabilities for PRD §4 adapters. */
import { expect, expectTypeOf, test } from "vitest";
import { parseQuestions } from "../../../src/codex/questions/definitions.ts";
import { QuestionLimitError } from "../../../src/codex/questions/limits.ts";
import {
  answeredQuestionItemIds,
  payloadOf,
  type QuestionCall,
  questionCall,
  queuedKey,
} from "../../../src/codex/questions/records.ts";
import { records } from "./fixtures.ts";

test("preserves modal IDs and queued ordinals as distinct identity shapes", () => {
  const queued = parseQuestions([{ title: "One" }, { title: "Two" }], true)!;
  expect(queued.map(({ questionIndex }) => questionIndex)).toEqual([0, 1]);
  expect(queued.every((question) => !("nativeId" in question))).toBe(true);
  const modal = parseQuestions(
    [{ id: "native-id", question: "Q", options: [{ label: "A" }] }],
    false,
  )!;
  expect(modal[0]).toMatchObject({ nativeId: "native-id" });
  expect(modal[0]).not.toHaveProperty("questionIndex");
  expect(queuedKey("call", 1)).toBe('["request_user_input_async","call",1]');
});
test("suggestion labels accept exactly 512 UTF-8 bytes and omit larger labels", () => {
  const exact = "é".repeat(256);
  const parsed = parseQuestions([{ title: "Q", options: [exact, `${exact}x`] }], true)!;
  expect(parsed[0]?.definition.options).toEqual([{ label: exact }]);
});
test.each([
  true,
  "true",
  "false",
  1,
  0,
  null,
  [],
  {},
  undefined,
])("supplied unsupported isSecret metadata never grants non-secret capabilities: %j", (isSecret) => {
  expect(parseQuestions([{ title: "Q", isSecret }], true)).toBeUndefined();
  expect(
    parseQuestions([{ id: "q", question: "Q", options: [{ label: "A" }], isSecret }], false),
  ).toBeUndefined();
});
test("absent and false secret flags preserve supported capability declarations", () => {
  for (const flags of [{}, { isSecret: false }]) {
    expect(parseQuestions([{ title: "Q", ...flags }], true)?.[0]?.definition.secret).toBe(false);
    expect(
      parseQuestions([{ id: "q", question: "Q", options: [{ label: "A" }], ...flags }], false)?.[0]
        ?.definition.secret,
    ).toBe(false);
  }
});
test("captured durable native calls and mirrors retain their acceptance distinction", () => {
  const queued = records("async-records.json")
    .map(payloadOf)
    .filter((value) => value !== undefined);
  const call = questionCall(queued[0]!);
  const mirror = questionCall(queued[1]!);
  const expectedCallId = "call_c54736dbd68049d192ab5f52ad2532f0";
  expect(call).toMatchObject({ callId: expectedCallId, accepted: false, queued: true });
  expect(mirror).toMatchObject({ callId: expectedCallId, accepted: true, queued: true });
  if (!(call?.queued && mirror?.queued)) throw new Error("Captured async requests must parse");
  const replyIds = queued.flatMap(answeredQuestionItemIds);
  expect(replyIds).toEqual(
    call.questions.map(({ questionIndex }) => queuedKey(call.callId, questionIndex)),
  );
  expect(replyIds).toEqual(
    mirror.questions.map(({ questionIndex }) => queuedKey(mirror.callId, questionIndex)),
  );
  const modal = records("blocking-records.json")
    .map(payloadOf)
    .filter((value) => value !== undefined);
  expect(questionCall(modal[0]!)).toMatchObject({
    callId: "call_8aaf11dc88ec4e7cb1d51793fea2de2c",
    queued: false,
  });
});
test("decoded native metadata accepts exactly 1 MiB with its identity", () => {
  const overhead = Buffer.byteLength(JSON.stringify(["id", [{ title: "" }]]));
  const remaining = 1024 * 1024 - overhead;
  const title = "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
  const value = { type: "AgentMessage", id: "id", delivery: "async", questions: [{ title }] };
  expect(questionCall(value)?.questions[0]?.definition.prompt).toBe(title);
  expect(() => questionCall({ ...value, questions: [{ title: `${title}x` }] })).toThrow(
    QuestionLimitError,
  );
});

test("native call flags narrow their identity and reject contradictory states", () => {
  type Modal = Extract<QuestionCall, { queued: false }>;
  type Queued = Extract<QuestionCall, { queued: true }>;
  expectTypeOf<Modal["accepted"]>().toEqualTypeOf<false>();
  expectTypeOf<Modal["questions"][number]["nativeId"]>().toEqualTypeOf<string>();
  expectTypeOf<Queued["questions"][number]["questionIndex"]>().toEqualTypeOf<number>();
  expectTypeOf<{
    callId: string;
    queued: false;
    accepted: true;
    questions: Modal["questions"];
  }>().not.toExtend<QuestionCall>();
  expectTypeOf<{
    callId: string;
    queued: true;
    accepted: false;
    questions: Modal["questions"];
  }>().not.toExtend<QuestionCall>();
  expectTypeOf<{
    callId: string;
    queued: false;
    accepted: false;
    questions: Queued["questions"];
  }>().not.toExtend<QuestionCall>();
});

test.each([undefined, ""])("rejects modal calls with an invalid durable identity %j", (callId) => {
  expect(
    questionCall({
      type: "function_call",
      name: "request_user_input",
      call_id: callId,
      arguments: JSON.stringify({
        questions: [{ id: "q", question: "Q", options: [{ label: "A" }] }],
      }),
    }),
  ).toBeUndefined();
});
