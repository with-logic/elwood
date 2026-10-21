/** Replay captured full native editor acceptance values for PRD §4. */
import { expect, test } from "vitest";
import { questionReplies, queuedKey } from "../../../src/codex/questions/records.ts";
import { isRecord, isStringArray } from "../../../src/core/predicates.ts";
import { event, setup } from "./candidate-helpers.ts";
import { fixture } from "./helpers.ts";

function recordFixture(name: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fixture(`editor/${name}`));
  if (!isRecord(value)) throw new Error("Expected a native fixture object");
  return value;
}
function stringField(value: Record<string, unknown>, field: string): string {
  const text = value[field];
  if (typeof text !== "string" || !text) throw new Error(`Invalid native fixture ${field}`);
  return text;
}
test.each([
  "queued",
  "modal",
])("accepts captured %s literal placeholders and full clipped long answers", (mode) => {
  const expected = recordFixture(`${mode}-expected.json`);
  const acceptance = recordFixture(`${mode}-acceptance.json`);
  const queued = mode === "queued";
  const callId = queued
    ? "call_9f8fad43431b4ac3afae9756c0f9a7f7"
    : stringField(acceptance, "callId");
  const answerCases = ["literal", "long"];
  for (const answerCase of answerCases) stringField(expected, answerCase);
  const { state, listener, registry } = setup();
  const questions = answerCases.map((answerCase) =>
    queued
      ? { title: answerCase }
      : { id: answerCase, question: answerCase, options: [{ label: "Yes" }] },
  );
  state.observe(
    event({
      type: "function_call",
      name: queued ? "request_user_input_async" : "request_user_input",
      call_id: callId,
      arguments: JSON.stringify({ questions }),
    }),
  );
  const candidateKeys = queued ? answerCases.map((_, index) => queuedKey(callId, index)) : [callId];
  expect([...state.candidates.keys()]).toEqual(candidateKeys);
  for (const key of candidateKeys) {
    const candidate = state.candidates.get(key);
    if (!candidate) throw new Error(`Missing captured native candidate ${key}`);
    state.publish(candidate);
    const answers = candidate.questions.map((question) => ({
      optionIndexes: [],
      text: stringField(expected, question.definition.prompt),
    }));
    state.expectAnswer(candidate, answers, new AbortController().signal);
  }
  const requests = registry.list();
  expect(requests).toHaveLength(candidateKeys.length);
  if (queued) {
    const payload = {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: `<send_user_message_question_reply>${JSON.stringify(acceptance["answers"])}</send_user_message_question_reply>`,
        },
      ],
    };
    const native = questionReplies(payload);
    if (
      native.length !== answerCases.length ||
      native.some((answer, index) => answer.questionItemId !== queuedKey(callId, index))
    )
      throw new Error("Invalid captured queued answers");
    state.observe(event(payload));
  } else {
    const native = acceptance["answers"];
    if (
      !isRecord(native) ||
      answerCases.some((answerCase) => {
        const answer = native[answerCase];
        return !(isRecord(answer) && isStringArray(answer["answers"]));
      })
    )
      throw new Error("Invalid captured modal answers");
    state.observe(
      event({
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({ answers: acceptance["answers"] }),
      }),
    );
  }
  expect(state.candidates.size).toBe(0);
  for (const request of requests)
    expect(listener).toHaveBeenCalledWith(
      "question",
      expect.objectContaining({ phase: "closed", reason: "answered", request }),
    );
  expect(listener).not.toHaveBeenCalledWith(
    "question",
    expect.objectContaining({ reason: "unavailable" }),
  );
});
