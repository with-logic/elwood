/** Codex catalog transitions, cached membership, and reservations (PRD §4). */
import { describe, expect, test } from "vitest";
import { call, event, setup } from "./candidate-helpers.ts";

describe("native candidate transitions", () => {
  test("changes only for native state transitions and preserves cached accepted identities", () => {
    const { state } = setup();
    expect(state.observe(event(call()))).toBe(true);
    expect(state.hasReservation()).toBe(true);
    const candidate = [...state.candidates.values()][0]!;
    const empty = state.acceptedQueuedCandidates();
    expect(state.observe(event(call()))).toBe(false);
    expect([...state.candidates.values()][0]).toBe(candidate);
    expect(state.acceptedQueuedCandidates()).toBe(empty);
    expect(state.observe(event(call("call", true, true)))).toBe(true);
    const accepted = state.acceptedQueuedCandidates();
    expect(accepted).toEqual([candidate]);
    expect(state.observe(event(call("call", true, true)))).toBe(false);
    expect(state.acceptedQueuedCandidates()).toBe(accepted);
    expect(state.unpublishedCandidates().size).toBe(1);
    state.publish(candidate);
    expect(state.unpublishedCandidates().size).toBe(0);
    state.publish(candidate);
    expect(state.observe(event({ type: "turn_complete" }))).toBe(true);
    expect(state.hasReservation()).toBe(false);
    expect(state.observe(event({ type: "turn_complete" }))).toBe(false);
  });
  test("classifies irrelevant records before inspecting arguments and output", () => {
    const { state } = setup();
    expect(
      state.observe(
        event({
          type: "function_call",
          name: "other",
          get arguments() {
            throw new Error("must not inspect");
          },
        }),
      ),
    ).toBe(false);
    expect(
      state.observe(
        event({
          type: "function_call_output",
          call_id: "other",
          get output() {
            throw new Error("must not inspect");
          },
        }),
      ),
    ).toBe(false);
  });
});

test("withdraws an exposed definition when its native authority becomes unsupported", () => {
  const { state, registry } = setup();
  state.observe(event(call("call", true, true)));
  state.publish(state.acceptedQueuedCandidates()[0]!);
  expect(
    state.observe(
      event({
        type: "function_call",
        name: "request_user_input_async",
        call_id: "call",
        arguments: '{"questions":[{"title":"secret","isSecret":true}]}',
      }),
    ),
  ).toBe(true);
  expect(registry.list()).toEqual([]);
  expect(state.candidates.size).toBe(0);
  expect(state.hasReservation()).toBe(true);
});

test("reserves malformed completed native messages without disturbing unrelated calls", () => {
  const { state } = setup();
  state.observe(event(call("other", true, true)));
  expect(
    state.observe(
      event({
        type: "item_completed",
        item: { type: "AgentMessage", id: "unsupported", delivery: "async", questions: [] },
      }),
    ),
  ).toBe(true);
  expect(
    state.observe(
      event({ type: "AgentMessage", id: "unsupported", delivery: "async", questions: [] }),
    ),
  ).toBe(false);
  expect(state.candidates.size).toBe(1);
  expect(state.hasReservation()).toBe(true);
});
