/** Independent accepted-value checks for public Codex question proofs (PRD §12, C-QUESTION-04). */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { ElwoodQuestionRequest } from "../../src/index.ts";
import {
  assertPublicCodexModalAnswers,
  assertPublicCodexQueuedAnswers,
  modalLiteralAnswer,
  publicCodexLongAnswer,
  publicCodexModalAnswers,
  publicCodexQueuedReplies,
  queuedLiteralAnswer,
} from "../e2e/questions/codex-public-answers.ts";

const long = publicCodexLongAnswer("UNIQUE_SYNTHETIC_ANSWER");
const queuedCallId = "native-async-call";
function envelope(answer: string, question: string, index: number, callId = queuedCallId) {
  return {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: `<send_user_message_question_reply>\n${JSON.stringify([
            {
              answer,
              question,
              questionItemId: JSON.stringify(["request_user_input_async", callId, index]),
            },
          ])}\n</send_user_message_question_reply>`,
        },
      ],
    },
  };
}
function queuedRecords(note = long.accepted, literal = queuedLiteralAnswer, callId = queuedCallId) {
  return [
    {
      type: "response_item",
      payload: { type: "function_call", name: "request_user_input_async", call_id: callId },
    },
    envelope(note, "ELWOOD_ASYNC_NOTE: What note?", 1, callId),
    envelope(literal, "ELWOOD_ASYNC_LITERAL: Enter the literal", 2, callId),
    envelope("Blue", "ELWOOD_ASYNC_COLOR: Which color?", 0, callId),
  ];
}
function modalRecords(note = long.accepted, literal = modalLiteralAnswer) {
  return [
    {
      type: "response_item",
      payload: { type: "function_call", name: "request_user_input", call_id: "modal-call" },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "modal-call",
        output: JSON.stringify({
          answers: {
            color: { answers: ["None of the above"] },
            note: { answers: ["Short", `user_note: ${note}`] },
            literal: { answers: ["None of the above", `user_note: ${literal}`] },
          },
        }),
      },
    },
  ];
}

test("C-QUESTION-04 long answer samples exercise native newline normalization and only outer trim", () => {
  assert.ok(long.text.length > 700);
  assert.ok(long.accepted.startsWith("\uFEFF"));
  assert.ok(long.accepted.endsWith("\uFEFF"));
  assert.match(long.text, /\r\n/);
  assert.match(long.text, /\r[^\n]/);
  assert.match(long.text, /\tINTERIOR\tTAB\tROW/);
  assert.equal(
    long.accepted,
    long.text.replace(/\r\n?/g, "\n").replace(/^\p{White_Space}+|\p{White_Space}+$/gu, ""),
  );
  assert.ok(long.accepted.includes("    > quoted-tail  \n    › caret-tail   \n"));
  assert.ok(long.accepted.includes("\n\tINTERIOR\tTAB\tROW\n"));
});

test("C-QUESTION-04 queued oracle decodes raw JSON and requires complete independent answers", () => {
  const records = queuedRecords();
  assertPublicCodexQueuedAnswers(records, long.accepted);
  assert.equal(publicCodexQueuedReplies(records)[0]?.["answer"], long.accepted);
  assert.throws(() => assertPublicCodexQueuedAnswers(queuedRecords("clipped"), long.accepted));
  assert.throws(() =>
    assertPublicCodexQueuedAnswers(queuedRecords(long.accepted, ""), long.accepted),
  );
  assert.throws(() => assertPublicCodexQueuedAnswers(records.slice(0, -1), long.accepted));
  assert.throws(() =>
    assertPublicCodexQueuedAnswers(
      queuedRecords(long.accepted.replace(/ +\n/g, "\n")),
      long.accepted,
    ),
  );
});

test("C-QUESTION-04 modal oracle requires full notes and a nonempty literal placeholder answer", () => {
  assertPublicCodexModalAnswers(modalRecords(), long.accepted);
  assert.throws(() => assertPublicCodexModalAnswers(modalRecords("clipped"), long.accepted));
  assert.throws(() =>
    assertPublicCodexModalAnswers(modalRecords(long.accepted, ""), long.accepted),
  );
  assert.throws(() =>
    assertPublicCodexModalAnswers(modalRecords(long.accepted.replaceAll("\t", " ")), long.accepted),
  );
});

test("C-QUESTION-04 modal public answers retain None, named choice plus long notes, and literal notes", () => {
  const request: ElwoodQuestionRequest = {
    id: "request",
    agent: "codex",
    delivery: "blocking",
    questions: ["Color", "Note", "Literal"].map((header) => ({
      id: header,
      header,
      prompt: `ELWOOD_${header}: Enter a value`,
      options: ["None of the above", "Short"].map((label) => ({ id: label, label })),
      selection: "single",
      textMode: "additional",
      supportsSecretInput: false,
    })),
  };
  assert.deepEqual(publicCodexModalAnswers(request, long.text), [
    { questionId: "Color", optionIds: ["None of the above"] },
    { questionId: "Note", optionIds: ["Short"], text: long.text },
    { questionId: "Literal", optionIds: ["None of the above"], text: modalLiteralAnswer },
  ]);
});

test.each([
  "output_text",
  undefined,
])("C-QUESTION-04 rejects non-input_text reply parts: %s", (type) => {
  const replies = [
    envelope(long.accepted, "ELWOOD_ASYNC_NOTE: What note?", 1),
    envelope(queuedLiteralAnswer, "ELWOOD_ASYNC_LITERAL: Enter the literal", 2),
    envelope("Blue", "ELWOOD_ASYNC_COLOR: Which color?", 0),
  ].map((item) => ({
    ...item,
    payload: { ...item.payload, content: item.payload.content.map((part) => ({ ...part, type })) },
  }));
  const records = [queuedRecords()[0], ...replies];
  assert.deepEqual(publicCodexQueuedReplies(records), []);
  assert.throws(() => assertPublicCodexQueuedAnswers(records, long.accepted));
});

test("C-QUESTION-04 rejects an empty queued call identity", () => {
  assert.throws(() =>
    assertPublicCodexQueuedAnswers(
      queuedRecords(long.accepted, queuedLiteralAnswer, ""),
      long.accepted,
    ),
  );
});

test.each([
  undefined,
  "",
  42,
])("C-QUESTION-04 rejects invalid modal call identity: %s", (callId) => {
  const records = modalRecords().map((item) => ({
    ...item,
    payload: { ...item.payload, call_id: callId },
  }));
  assert.throws(() => assertPublicCodexModalAnswers(records, long.accepted));
});
