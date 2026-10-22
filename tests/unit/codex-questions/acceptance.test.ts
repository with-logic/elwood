/** Verify complete native accepted values for owned PRD §4 question attempts. */
import { expect, test } from "vitest";
import { output, owned, reply } from "./acceptance-helpers.ts";
import { event } from "./candidate-helpers.ts";

test.each(["wrong", "Yes ", "Yes\n"])("rejects same-ID queued payload %j", (answer) => {
  const { state, candidate, controller, reason } = owned();
  state.expectAnswer(candidate, [{ optionIndexes: [0] }], controller.signal);
  state.observe(reply(candidate.nativeKey, answer));
  expect(reason()).toMatchObject({ phase: "closed", reason: "unavailable" });
});
test("rejects duplicate replies but never confirms from another ID", () => {
  const { state, candidate, controller, reason } = owned();
  state.expectAnswer(candidate, [{ optionIndexes: [0] }], controller.signal);
  expect(state.observe(reply("other", "Yes"))).toBe(false);
  expect(state.candidates.has(candidate.nativeKey)).toBe(true);
  state.observe(
    reply(candidate.nativeKey, "Yes", [{ questionItemId: candidate.nativeKey, answer: "Yes" }]),
  );
  expect(reason()).toMatchObject({ phase: "closed", reason: "unavailable" });
});
test.each([
  { q: { answers: ["No"] } },
  { q: { answers: ["Yes", "user_note: extra"] } },
  { q: { answers: ["Yes", "Yes"] } },
  { q: { answers: ["Yes"] }, other: { answers: ["Yes"] } },
  { other: { answers: ["Yes"] } },
  { q: null },
  { q: { answers: null } },
  null,
])("rejects incomplete or changed modal payload %j", (answers) => {
  const { state, candidate, controller, reason } = owned(false);
  state.expectAnswer(candidate, [{ optionIndexes: [0] }], controller.signal);
  state.observe(output(answers));
  expect(reason()).toMatchObject({ phase: "closed", reason: "unavailable" });
});
test.each([
  true,
  false,
])("accepts full normalized text including invisible whitespace (queued=%s)", (queued) => {
  const { state, candidate, controller, listener } = owned(queued);
  const text = "\u0085\u2003\ufefffirst\r\n  > interior  \r  › caret   \nlast\ufeff\u3000";
  const normalized = "\ufefffirst\n  > interior  \n  › caret   \nlast\ufeff";
  state.expectAnswer(candidate, [{ optionIndexes: [], text }], controller.signal);
  state.observe(
    queued
      ? reply(candidate.nativeKey, normalized)
      : output({ q: { answers: ["None of the above", `user_note: ${normalized}`] } }),
  );
  expect(listener).toHaveBeenCalledWith(
    "question",
    expect.objectContaining({ phase: "closed", reason: "answered" }),
  );
});
test("modal selection can have precisely matching notes", () => {
  const { state, candidate, controller, listener } = owned(false);
  state.expectAnswer(candidate, [{ optionIndexes: [0], text: " note " }], controller.signal);
  state.observe(output({ q: { answers: ["Yes", "user_note: note"] } }));
  expect(listener).toHaveBeenCalledWith(
    "question",
    expect.objectContaining({ reason: "answered" }),
  );
});

test("queued reply envelopes cannot confirm a blocking call", () => {
  const { state, candidate, controller, listener } = owned(false);
  state.expectAnswer(candidate, [{ optionIndexes: [0] }], controller.signal);
  expect(state.observe(reply(candidate.nativeKey, "Yes"))).toBe(false);
  expect(state.candidates.has(candidate.nativeKey)).toBe(true);
  expect(listener).not.toHaveBeenCalledWith(
    "question",
    expect.objectContaining({ phase: "closed" }),
  );
});

test("Rust trim removes a non-JavaScript whitespace-only value", () => {
  const { state, candidate, controller, listener } = owned();
  state.expectAnswer(candidate, [{ optionIndexes: [], text: "\u0085" }], controller.signal);
  state.observe(reply(candidate.nativeKey, ""));
  expect(listener).toHaveBeenCalledWith(
    "question",
    expect.objectContaining({ reason: "answered" }),
  );
});

test("a malformed duplicate cannot disappear into a valid queued acknowledgement", () => {
  const { state, candidate, controller, listener } = owned();
  state.expectAnswer(candidate, [{ optionIndexes: [0] }], controller.signal);
  expect(
    state.observe(
      reply(candidate.nativeKey, "Yes", [{ questionItemId: candidate.nativeKey, answer: 3 }]),
    ),
  ).toBe(false);
  expect(state.candidates.has(candidate.nativeKey)).toBe(true);
  expect(listener).not.toHaveBeenCalledWith(
    "question",
    expect.objectContaining({ phase: "closed" }),
  );
});
test("modal outer-whitespace-only notes are omitted by native submission", () => {
  const { state, candidate, controller, listener } = owned(false);
  state.expectAnswer(candidate, [{ optionIndexes: [], text: "\u0085" }], controller.signal);
  state.observe(output({ q: { answers: ["None of the above"] } }));
  expect(listener).toHaveBeenCalledWith(
    "question",
    expect.objectContaining({ reason: "answered" }),
  );
});

test("queued selected labels are trimmed without changing interior carriage returns", () => {
  const { state, candidate, controller, reason } = owned();
  state.observe(
    event({
      type: "function_call",
      name: "request_user_input_async",
      call_id: "call",
      arguments: JSON.stringify({
        questions: [{ title: "Pick", options: ["\u0085 A\rB \u0085"] }],
      }),
    }),
  );
  const current = [...state.candidates.values()][0]!;
  expect(current).not.toBe(candidate);
  state.publish(current);
  state.expectAnswer(current, [{ optionIndexes: [0] }], controller.signal);
  state.observe(reply(current.nativeKey, "A\rB"));
  expect(reason()).toMatchObject({ reason: "answered" });
});
