/** Core expectation disposal and manual fallback boundaries (PRD §4). */
import { expect, test, vi } from "vitest";
import { output, owned, reply } from "./acceptance-helpers.ts";

test.each([
  true,
  false,
])("abort/dispose clears owned values and retains manual native classification (%s)", (abort) => {
  const { state, candidate, controller, listener } = owned();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const dispose = state.expectAnswer(candidate, [{ optionIndexes: [0] }], controller.signal);
  expect(() => state.expectAnswer(candidate, [{ optionIndexes: [0] }], controller.signal)).toThrow(
    expect.objectContaining({ code: "question_answer_failed" }),
  );
  if (abort) controller.abort();
  else dispose();
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  state.observe(reply(candidate.nativeKey, "manual different answer"));
  expect(listener).toHaveBeenCalledWith(
    "question",
    expect.objectContaining({ reason: "answered" }),
  );
});
test("stale disposer cannot revoke a later attempt", () => {
  const { state, candidate, controller, reason } = owned();
  const dispose = state.expectAnswer(candidate, [{ optionIndexes: [0] }], controller.signal);
  dispose();
  state.expectAnswer(candidate, [{ optionIndexes: [0] }], controller.signal);
  dispose();
  state.observe(reply(candidate.nativeKey, "wrong"));
  expect(reason()).toMatchObject({ reason: "unavailable" });
});
test("already aborted attempts cannot install an expectation", () => {
  const { state, candidate, controller } = owned(false);
  controller.abort();
  expect(() => state.expectAnswer(candidate, [{ optionIndexes: [0] }], controller.signal)).toThrow(
    expect.objectContaining({ code: "question_answer_failed" }),
  );
  state.observe(output({ q: { answers: ["manual"] } }));
  expect(state.candidates.size).toBe(0);
  expect(() =>
    state.expectAnswer(candidate, [{ optionIndexes: [0] }], new AbortController().signal),
  ).toThrow(expect.objectContaining({ code: "question_answer_failed" }));
});
