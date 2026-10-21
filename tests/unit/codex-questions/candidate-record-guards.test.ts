/** Untrusted record types cannot settle PRD §4 native question reservations. */
import { expect, test } from "vitest";
import { call, event, setup } from "./candidate-helpers.ts";

test.each([
  "turn_complete",
  "task_complete",
  "turn_aborted",
  "turn_failed",
])("does not coerce malformed completion type %s", (type) => {
  const { state, registry } = setup();
  state.observe(event(call("call", true, true)));
  for (const candidate of state.unpublishedCandidates()) state.publish(candidate);
  expect(state.observe(event({ type: [type] }))).toBe(false);
  expect(state.acceptedQueuedCandidates()).toHaveLength(1);
  expect(registry.list()).toHaveLength(1);
});

test("holds a recognized unsupported envelope with a malformed native call identity", () => {
  const { state } = setup();
  expect(
    state.observe(
      event({
        type: "function_call",
        name: "request_user_input_async",
        call_id: 3,
        arguments: "{}",
      }),
    ),
  ).toBe(true);
  expect(state.candidates.size).toBe(0);
  expect(state.hasReservation()).toBe(true);
});
