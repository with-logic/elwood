/** Catalog resource limits preserve native holds and one-shot diagnostics (PRD §4). */
import { describe, expect, test } from "vitest";
import { call, event, setup } from "./candidate-helpers.ts";

describe("candidate resource budgets", () => {
  test("accepts 256 pending candidates then closes all exposed requests and signals once", () => {
    const { state, registry, disabled } = setup(true);
    for (let index = 0; index < 256; index++) state.observe(event(call(String(index), true, true)));
    expect(state.acceptedQueuedCandidates()).toHaveLength(256);
    for (const candidate of state.unpublishedCandidates()) state.publish(candidate);
    expect(registry.list()).toHaveLength(256);
    expect(state.observe(event(call("overflow", true, true)))).toBe(true);
    expect(registry.list()).toEqual([]);
    expect(state.candidates.size).toBe(0);
    expect(state.unpublishedCandidates().size).toBe(0);
    expect(state.hasReservation()).toBe(true);
    expect(disabled).toHaveBeenCalledTimes(1);
    expect(state.observe(event(call()))).toBe(false);
    expect(state.observe(event({ type: "other" }))).toBe(false);
    expect(state.close("old", "unavailable")).toBe(false);
    expect(state.observe(event({ type: "turn_failed" }))).toBe(true);
    expect(state.hasReservation()).toBe(false);
    expect(state.observe(event(call()))).toBe(true);
    expect(disabled).toHaveBeenCalledTimes(1);
  });
});

test("cannot reopen candidates when replacement exhausts the retirement budget", () => {
  const { state, registry } = setup();
  for (let index = 0; index < 4096; index++) state.close(String(index), "answered");
  state.observe(
    event({
      type: "AgentMessage",
      id: "call",
      delivery: "async",
      questions: [{ title: "Pick", options: ["Yes"] }, { title: "Removed" }],
    }),
  );
  state.observe(event(call("call", true, true)));
  for (const candidate of state.unpublishedCandidates()) state.publish(candidate);
  expect(state.candidates.size).toBe(0);
  expect(registry.list()).toEqual([]);
  expect(state.hasReservation()).toBe(true);
});
