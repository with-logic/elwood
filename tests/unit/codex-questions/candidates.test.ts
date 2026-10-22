/** Codex catalog transitions, cached membership, and reservations (PRD §4). */
import { describe, expect, test } from "vitest";
import { call, event, setup } from "./candidate-helpers.ts";

describe("native candidate transitions", () => {
  test("changes only for native state transitions and preserves cached accepted identities", () => {
    const { state } = setup();
    expect(state.observe(event(call()))).toBe(true);
    expect(state.hasReservation()).toBe(true);
    const candidate = [...state.candidates.values()][0]!;
    const empty = state.availableAcceptedQueuedCandidates();
    expect(state.observe(event(call()))).toBe(false);
    expect([...state.candidates.values()][0]).toBe(candidate);
    expect(state.availableAcceptedQueuedCandidates()).toBe(empty);
    expect(state.observe(event(call({ id: "call", queued: true, accepted: true })))).toBe(true);
    const accepted = state.availableAcceptedQueuedCandidates();
    expect(accepted).toEqual([candidate]);
    expect(state.observe(event(call({ id: "call", queued: true, accepted: true })))).toBe(false);
    expect(state.availableAcceptedQueuedCandidates()).toBe(accepted);
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
  test("reserves unsupported native questions until explicit live clearance", () => {
    const { state, disabled } = setup();
    expect(
      state.observe(
        event({
          type: "function_call",
          name: "request_user_input",
          call_id: "secret",
          arguments: '{"questions":[{"isSecret":true}]}',
        }),
      ),
    ).toBe(true);
    expect(state.hasReservation()).toBe(true);
    expect(state.candidates.size).toBe(0);
    expect(disabled).not.toHaveBeenCalled();
    expect(state.clearOpaqueReservation()).toBe(true);
    expect(state.clearOpaqueReservation()).toBe(false);
  });
});

test("withdraws an exposed definition when its native authority becomes unsupported", () => {
  const { state, registry } = setup();
  state.observe(event(call({ id: "call", queued: true, accepted: true })));
  state.publish(state.availableAcceptedQueuedCandidates()[0]!);
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

test("withdraws removed queued units when the same native call has fewer definitions", () => {
  const { state, registry } = setup();
  state.observe(
    event({
      type: "AgentMessage",
      id: "call",
      delivery: "async",
      questions: [{ title: "Pick", options: ["Yes"] }, { title: "Removed" }],
    }),
  );
  expect(
    state
      .availableAcceptedQueuedCandidates()
      .map((candidate) => candidate.questions[0]?.definition.prompt),
  ).toEqual(["Pick", "Removed"]);
  for (const candidate of state.unpublishedCandidates()) state.publish(candidate);
  expect(registry.list().map((request) => request.questions[0]?.prompt)).toEqual([
    "Pick",
    "Removed",
  ]);
  expect(state.observe(event(call({ id: "call", queued: true, accepted: true })))).toBe(true);
  expect(
    state
      .availableAcceptedQueuedCandidates()
      .map((candidate) => candidate.questions[0]?.definition.prompt),
  ).toEqual(["Pick"]);
  expect(registry.list().map((request) => request.questions[0]?.prompt)).toEqual(["Pick"]);
});

test("reserves malformed completed native messages without disturbing unrelated calls", () => {
  const { state } = setup();
  state.observe(event(call({ id: "other", queued: true, accepted: true })));
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
