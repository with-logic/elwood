/** Catalog resource limits preserve native holds and one-shot diagnostics (PRD §4). */
import { describe, expect, test } from "vitest";
import { CodexQuestionCandidates } from "../../../src/codex/questions/candidates.ts";
import { QuestionObserverFailure } from "../../../src/core/questions/notification-errors.ts";
import { QuestionRegistry } from "../../../src/core/questions/registry.ts";
import { call, event, overflowingMetadataCall, setup } from "./candidate-helpers.ts";

describe("candidate resource budgets", () => {
  test("accepts 256 pending candidates then closes all exposed requests and signals once", () => {
    const { state, registry, disabled } = setup(true);
    for (let index = 0; index < 256; index++)
      state.observe(event(call({ id: String(index), queued: true, accepted: true })));
    expect(state.availableAcceptedQueuedCandidates()).toHaveLength(256);
    expect(() =>
      state.batchNotifications(() => {
        for (const candidate of state.unpublishedCandidates()) state.publish(candidate);
      }),
    ).toThrow(QuestionObserverFailure);
    expect(registry.list()).toHaveLength(256);
    expect(() =>
      state.observe(event(call({ id: "overflow", queued: true, accepted: true }))),
    ).toThrow(QuestionObserverFailure);
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
  test("signals overflow before first publication and contains diagnostic observer failures", () => {
    const registry = new QuestionRegistry("codex", "session", { emit() {} });
    const state = new CodexQuestionCandidates(registry, () => {
      throw new Error("diagnostic");
    });
    expect(state.observe(event(overflowingMetadataCall()))).toBe(true);
    expect(state.hasReservation()).toBe(true);
    expect(registry.list()).toEqual([]);
    const quiet = new CodexQuestionCandidates(registry);
    expect(quiet.observe(event(overflowingMetadataCall()))).toBe(true);
  });
  test("bounds aggregate candidate metadata independently of each definition", () => {
    const { state, disabled } = setup();
    const validPrompt = "x".repeat(200_000);
    for (let index = 0; index < 5; index++) {
      state.observe(
        event(call({ id: String(index), queued: true, accepted: true, prompt: validPrompt })),
      );
      expect(state.availableAcceptedQueuedCandidates()).toHaveLength(index + 1);
      expect(disabled).not.toHaveBeenCalled();
    }
    state.observe(event(call({ id: "sixth", queued: true, accepted: true, prompt: validPrompt })));
    expect(disabled).toHaveBeenCalledTimes(1);
    expect(state.candidates.size).toBe(0);
    expect(state.availableAcceptedQueuedCandidates()).toEqual([]);
    expect(state.hasReservation()).toBe(true);
  });
  test("bounds retired identity count without re-enabling automation on clearance", () => {
    const { state, disabled } = setup();
    for (let index = 0; index < 4096; index++)
      expect(state.close(String(index), "answered")).toBe(false);
    expect(disabled).not.toHaveBeenCalled();
    expect(state.close("overflow", "answered")).toBe(true);
    expect(disabled).toHaveBeenCalledTimes(1);
    state.clearOpaqueReservation();
    expect(state.observe(event(call()))).toBe(true);
    expect(state.candidates.size).toBe(0);
  });
  test("bounds retired identity bytes", () => {
    const { state, disabled } = setup();
    expect(state.close("a".repeat(600_000), "answered")).toBe(false);
    expect(state.close("b".repeat(600_000), "answered")).toBe(true);
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
  state.observe(event(call({ id: "call", queued: true, accepted: true })));
  for (const candidate of state.unpublishedCandidates()) state.publish(candidate);
  expect(state.candidates.size).toBe(0);
  expect(registry.list()).toEqual([]);
  expect(state.hasReservation()).toBe(true);
});
