/** Review regressions for accepted native authority and lifecycle interruption (PRD §4). */
import { expect, test } from "vitest";
import { call, event, setup } from "./candidate-helpers.ts";

function queued(questions: readonly { readonly title: string }[]) {
  return event({
    type: "function_call",
    call_id: "call",
    name: "request_user_input_async",
    arguments: JSON.stringify({ questions }),
  });
}
test("cannot resurrect remaining replacement groups after a reentrant native turn end", () => {
  const { state, registry } = setup();
  state.observe(event(call("call", true, true)));
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
