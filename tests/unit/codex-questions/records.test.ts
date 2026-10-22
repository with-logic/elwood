/** Native Codex question metadata validation for the PRD §4 adapter boundary. */
import { expect, test, vi } from "vitest";
import { parseQuestions } from "../../../src/codex/questions/definitions.ts";
import {
  QuestionLimitError,
  questionMetadataLimitBytes,
} from "../../../src/codex/questions/limits.ts";
import {
  answeredQuestionItemIds,
  jsonRecord,
  payloadOf,
  questionCall,
} from "../../../src/codex/questions/records.ts";

test("mirrors native async suggestion limits and optional fields", () => {
  const options = ["é".repeat(257), "Blue", ...Array.from({ length: 31 }, (_, i) => String(i))];
  const result = parseQuestions(
    [
      { title: "Question", options, header: "Header" },
      { title: "Free", options: null },
    ],
    true,
  );
  expect(result?.[0]?.definition.options).toEqual([
    { label: "Blue" },
    ...Array.from({ length: 30 }, (_, index) => ({ label: String(index) })),
  ]);
  expect(result?.[0]?.definition.header).toBe("Header");
  expect(result?.[1]?.definition.selection).toBe("none");
  expect(result?.[1]?.definition.options).toEqual([]);
  expect(
    parseQuestions([{ id: "id", question: "Q", options: [{ label: "A" }] }], false)?.[0]?.definition
      .options,
  ).toEqual([
    { label: "A" },
    { label: "None of the above", description: "Optionally, add details in notes (tab)" },
  ]);
});
test.each([
  undefined,
  [],
  [null],
  [{ title: 3 }],
  [{ title: " " }],
  [{ title: "Q", isSecret: true }],
  [{ title: "Q", options: 3 }],
  [{ title: "Q", options: [] }],
  [{ title: "Q", options: [null] }],
  [{ title: "Q", options: [""] }],
])("rejects invalid async question metadata %j", (value) => {
  expect(parseQuestions(value, true)).toBeUndefined();
});
test.each([
  { id: "q", question: "Q", options: [] },
  { id: "q", question: "Q", options: [null] },
  { id: "q", question: "Q", options: [{ label: 3 }] },
  { id: "q", question: "Q", options: [{ label: " " }] },
  { question: "Q", options: [{ label: "A" }] },
])("rejects invalid modal metadata %j", (value) => {
  expect(parseQuestions([value], false)).toBeUndefined();
});
test("parses only complete durable native call shapes", () => {
  expect(payloadOf(null)).toBeUndefined();
  expect(payloadOf({ payload: [] })).toBeUndefined();
  expect(jsonRecord(undefined)).toBeUndefined();
  expect(jsonRecord("{")).toBeUndefined();
  expect(jsonRecord("[]")).toBeUndefined();
  expect(questionCall({ type: "function_call", name: "other" })).toBeUndefined();
  for (const name of ["request_user_input", "request_user_input_async"])
    expect(
      questionCall({ type: "function_call", name, call_id: "id", arguments: "{" }),
    ).toBeUndefined();
  expect(questionCall({ type: "item_completed", item: null })).toBeUndefined();
  expect(
    questionCall({ type: "unknown", id: "id", delivery: "async", questions: [{ title: "Q" }] }),
  ).toBeUndefined();
  expect(
    questionCall({
      type: "message",
      role: "user",
      id: "id",
      delivery: "async",
      questions: [{ title: "Q" }],
    }),
  ).toBeUndefined();
  expect(
    questionCall({
      type: "message",
      role: "assistant",
      id: "id",
      delivery: "async",
      questions: [{ title: "Q" }],
    })?.accepted,
  ).toBe(true);
  expect(
    questionCall({ type: "agent_message", delivery: "async", questions: [{ title: "Q" }] }),
  ).toBeUndefined();
  expect(
    questionCall({ type: "agent_message", delivery: "async", id: "", questions: [{ title: "Q" }] }),
  ).toBeUndefined();
  expect(
    questionCall({ type: "AgentMessage", delivery: "async", id: "id", questions: [{ title: "Q" }] })
      ?.accepted,
  ).toBe(true);
});
test("recognizes native committed reply envelopes, never arbitrary prose", () => {
  const wrapped = (text: unknown) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  });
  expect(answeredQuestionItemIds({ type: "message", role: "assistant", content: [] })).toEqual([]);
  expect(answeredQuestionItemIds({ type: "message", role: "user", content: null })).toEqual([]);
  expect(
    answeredQuestionItemIds({
      type: "message",
      role: "user",
      content: [null, { type: "other" }, { type: "input_text", text: 3 }],
    }),
  ).toEqual([]);
  for (const body of [
    "not native",
    "<send_user_message_question_reply>{</send_user_message_question_reply>",
    "<send_user_message_question_reply>{}</send_user_message_question_reply>",
    '<send_user_message_question_reply>[null,{"questionItemId":3},{"questionItemId":"id","answer":3}]</send_user_message_question_reply>',
  ])
    expect(answeredQuestionItemIds(wrapped(body))).toEqual([]);
  expect(
    answeredQuestionItemIds(
      wrapped(
        '<send_user_message_question_reply>[{"questionItemId":"id","answer":"A"}]</send_user_message_question_reply>',
      ),
    ),
  ).toEqual(["id"]);
});

test.each([
  "request_user_input",
  "request_user_input_async",
])("%s bounds malformed raw arguments before parsing", (name) => {
  const argumentsValue = "{".repeat(questionMetadataLimitBytes + 1);
  const parse = vi.spyOn(JSON, "parse");
  try {
    expect(() =>
      questionCall({
        type: "function_call",
        name,
        call_id: "id",
        arguments: argumentsValue,
      }),
    ).toThrow(QuestionLimitError);
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});

test.each([
  undefined,
  "sync",
])("assistant question mirrors require async delivery: %j", (delivery) => {
  const message = {
    type: "message",
    role: "assistant",
    id: "id",
    questions: [{ title: "Q", options: ["A"] }],
  };
  expect(questionCall({ ...message, delivery: "async" })).toMatchObject({
    callId: "id",
    accepted: true,
    queued: true,
  });
  expect(
    questionCall({ ...message, ...(delivery === undefined ? {} : { delivery }) }),
  ).toBeUndefined();
});
