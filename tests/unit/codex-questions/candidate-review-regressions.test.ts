/** Review regressions for accepted native authority and lifecycle interruption (PRD §4). */
import { expect, test } from "vitest";
import { call, event, overflowingMetadataCall, setup } from "./candidate-helpers.ts";

function queued(questions: readonly { readonly title: string }[]) {
  return event({
    type: "function_call",
    call_id: "call",
    name: "request_user_input_async",
    arguments: JSON.stringify({ questions }),
  });
}
test.each([
  "AgentMessage",
  "function_call_output",
])("preserves native call acceptance across replacement and new units (evidence: %s)", (evidence) => {
  const acceptedMirror = evidence === "AgentMessage";
  const { state, registry } = setup();
  state.observe(event(call({ id: "call", queued: true, accepted: acceptedMirror })));
  if (!acceptedMirror)
    state.observe(
      event({ type: "function_call_output", call_id: "call", output: '{"accepted":true}' }),
    );
  state.publish(state.acceptedQueuedCandidates()[0]!);
  expect(state.observe(queued([{ title: "Changed" }, { title: "Added" }]))).toBe(true);
  expect(registry.list()).toEqual([]);
  expect(
    state.acceptedQueuedCandidates().map((candidate) => candidate.questions[0]!.definition.prompt),
  ).toEqual(["Changed", "Added"]);
  for (const candidate of state.unpublishedCandidates()) state.publish(candidate);
  expect(registry.list()).toHaveLength(2);
});
test("cannot resurrect remaining replacement groups after a reentrant native turn end", () => {
  const { state, registry } = setup();
  state.observe(event(call({ id: "call", queued: true, accepted: true })));
  state.publish(state.acceptedQueuedCandidates()[0]!);
  registry.onEvent((edge) => {
    if (edge.phase === "closed") state.observe(event({ type: "turn_complete" }));
  });
  expect(state.observe(queued([{ title: "Changed" }, { title: "Added" }]))).toBe(true);
  expect(state.candidates.size).toBe(0);
  expect(state.unpublishedCandidates().size).toBe(0);
  expect(state.acceptedQueuedCandidates()).toEqual([]);
  expect(state.hasReservation()).toBe(false);
  expect(registry.list()).toEqual([]);
});
test("invalidates materialized accepted membership when a native unit closes", () => {
  const { state } = setup();
  state.observe(event(call({ id: "a", queued: true, accepted: true })));
  state.observe(event(call({ id: "b", queued: true, accepted: true })));
  const before = state.acceptedQueuedCandidates();
  expect(before).toHaveLength(2);
  state.close(before[0]!.nativeKey, "answered");
  expect(state.acceptedQueuedCandidates()).toEqual([before[1]]);
});
test("invalidates materialized accepted membership when automation disables", () => {
  const { state } = setup();
  state.observe(event(call({ id: "call", queued: true, accepted: true })));
  expect(state.acceptedQueuedCandidates()).toHaveLength(1);
  state.observe(event(overflowingMetadataCall()));
  expect(state.acceptedQueuedCandidates()).toEqual([]);
});
test("requires native answers for every question in a blocking request", () => {
  const { state, registry, listener } = setup();
  state.observe(
    event({
      type: "function_call",
      call_id: "blocking",
      name: "request_user_input",
      arguments: JSON.stringify({
        questions: ["first", "second"].map((id) => ({
          id,
          question: id,
          options: [{ label: "Yes" }],
        })),
      }),
    }),
  );
  state.publish([...state.candidates.values()][0]!);
  state.observe(
    event({
      type: "function_call_output",
      call_id: "blocking",
      output: JSON.stringify({ answers: { first: { answers: ["Yes"] } } }),
    }),
  );
  expect(registry.list()).toEqual([]);
  expect(listener).toHaveBeenCalledWith(
    "question",
    expect.objectContaining({ phase: "closed", reason: "unavailable" }),
  );
});
