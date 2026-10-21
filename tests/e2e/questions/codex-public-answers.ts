/** Full native acceptance oracles for public Codex question proofs (PRD §12, C-QUESTION-04). */
// biome-ignore-all lint/suspicious/noMisplacedAssertion: Assertions verify complete synthetic questionnaire answers.
import assert from "node:assert/strict";
import { record } from "../../../src/core/activity/meta.ts";
import type { ElwoodQuestionRequest } from "../../../src/index.ts";
import {
  nativeCodexFunctionCalls,
  nativeCodexFunctionOutput,
  nativeCodexQueuedReplies,
} from "./codex-records.ts";

export const queuedLiteralAnswer = "Type your answer";
export const modalLiteralAnswer = "Add notes";

/** Accepted text is specified separately from its CRLF/CR and outer-whitespace input. */
export function publicCodexLongAnswer(marker: string) {
  const first = `${marker} START ${Array.from({ length: 35 }, (_, i) => `item${i}-abcdef`).join(" ")}`;
  const quoted = "    > quoted-tail  ";
  const caret = "    › caret-tail   ";
  const tabs = "\tINTERIOR\tTAB\tROW";
  const last = `END ${"W".repeat(220)}`;
  return {
    text: `\u2003 \r\n\uFEFF${first}\r\n${quoted}\r${caret}\r\n${tabs}\r\n${last}\uFEFF\r\n \u2002\t`,
    accepted: [`\uFEFF${first}`, quoted, caret, tabs, `${last}\uFEFF`].join("\n"),
  };
}

/** Parse actual committed user-message envelopes; never compare their escaped JSON text. */
export function publicCodexQueuedReplies(records: readonly unknown[]) {
  return nativeCodexQueuedReplies(records).flatMap((answers) => {
    assert.ok(Array.isArray(answers), "Native queued reply must be an answer array");
    return answers.map(record);
  });
}

/** Require exactly one async call for the fixed Note/Literal/Color questionnaire. */
export function assertPublicCodexQueuedAnswers(records: readonly unknown[], acceptedNote: string) {
  const calls = nativeCodexFunctionCalls(records, "request_user_input_async");
  assert.equal(calls.length, 1, "One native async call must own all three questions");
  const callId = calls[0]?.["call_id"];
  assert.equal(typeof callId, "string");
  assert.deepEqual(publicCodexQueuedReplies(records), [
    {
      answer: acceptedNote,
      question: "ELWOOD_ASYNC_NOTE: What note?",
      questionItemId: JSON.stringify(["request_user_input_async", callId, 1]),
    },
    {
      answer: queuedLiteralAnswer,
      question: "ELWOOD_ASYNC_LITERAL: Enter the literal",
      questionItemId: JSON.stringify(["request_user_input_async", callId, 2]),
    },
    {
      answer: "Blue",
      question: "ELWOOD_ASYNC_COLOR: Which color?",
      questionItemId: JSON.stringify(["request_user_input_async", callId, 0]),
    },
  ]);
}

/** This mapping belongs only to the Color/Note/Literal native proof questionnaire. */
export function publicCodexModalAnswers(request: ElwoodQuestionRequest, note: string) {
  return request.questions.map((question) => {
    let label: string;
    let text: string | undefined;
    switch (question.header) {
      case "Color":
        label = "None of the above";
        break;
      case "Note":
        label = "Short";
        text = note;
        break;
      case "Literal":
        label = "None of the above";
        text = modalLiteralAnswer;
        break;
      default:
        throw new Error("Unexpected native proof question header");
    }
    const option = question.options.find((item) => item.label === label);
    assert.ok(option, `Native question must offer ${label}`);
    return {
      questionId: question.id,
      optionIds: [option.id],
      ...(text === undefined ? {} : { text }),
    };
  });
}

/** Require exactly one modal call and its complete fixed Color/Note/Literal answers. */
export function assertPublicCodexModalAnswers(records: readonly unknown[], acceptedNote: string) {
  const calls = nativeCodexFunctionCalls(records, "request_user_input");
  assert.equal(calls.length, 1, "One native modal call must own all three questions");
  const output = nativeCodexFunctionOutput(records, "request_user_input");
  assert.equal(typeof output, "string");
  assert.deepEqual(JSON.parse(String(output)), {
    answers: {
      color: { answers: ["None of the above"] },
      note: { answers: ["Short", `user_note: ${acceptedNote}`] },
      literal: { answers: ["None of the above", `user_note: ${modalLiteralAnswer}`] },
    },
  });
}
