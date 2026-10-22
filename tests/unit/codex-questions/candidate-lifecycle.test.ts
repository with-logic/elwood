/** Native acceptance, retirement, and observer isolation for PRD §4 catalogs. */
import { describe, expect, test } from "vitest";
import { queuedKey } from "../../../src/codex/questions/records.ts";
import { QuestionObserverFailure } from "../../../src/core/questions/notification-errors.ts";
import { call, event, setup } from "./candidate-helpers.ts";
import { records } from "./fixtures.ts";

function output(callId: string, value: unknown) {
  return event({ type: "function_call_output", call_id: callId, output: value });
}
describe("candidate native lifecycle", () => {
  test("native output accepts a queued candidate exactly once without publishing prematurely", () => {
    const { state, registry } = setup();
    state.observe(event(call()));
    const before = state.availableAcceptedQueuedCandidates();
    expect(state.observe(output("call", '{"accepted":true}'))).toBe(true);
    expect(state.availableAcceptedQueuedCandidates()).not.toBe(before);
    expect(state.observe(output("call", '{"accepted":true}'))).toBe(false);
    expect(registry.list()).toEqual([]);
  });
  test("replaces changed definitions and closes the old request before republishing", () => {
    const { state, registry, listener } = setup();
    state.observe(event(call({ id: "call", queued: true, accepted: true })));
    const old = state.availableAcceptedQueuedCandidates()[0]!;
    state.publish(old);
    const request = registry.list()[0]!;
    expect(
      state.observe(event(call({ id: "call", queued: true, accepted: true, prompt: "Changed" }))),
    ).toBe(true);
    expect(registry.get(request.id)).toBeUndefined();
    expect(listener).toHaveBeenCalledWith(
      "question",
      expect.objectContaining({ phase: "closed", reason: "unavailable" }),
    );
    state.publish(old);
    state.publish(state.availableAcceptedQueuedCandidates()[0]!);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]!.id).not.toBe(request.id);
  });
  test("continues every publication and closure when observers throw", () => {
    const { state, registry } = setup(true);
    for (const id of ["a", "b"]) state.observe(event(call({ id, queued: true, accepted: true })));
    expect(() =>
      state.batchNotifications(() => {
        for (const candidate of state.unpublishedCandidates()) state.publish(candidate);
      }),
    ).toThrow(QuestionObserverFailure);
    expect(registry.list()).toHaveLength(2);
    expect(() => state.observe(event({ type: "turn_aborted" }))).toThrow(QuestionObserverFailure);
    expect(registry.list()).toEqual([]);
    expect(state.candidates.size).toBe(0);
  });
  test.each([
    ['{"answers":{"q":{"answers":["Yes"]}}}', "answered"],
    ['{"answers":{"q":{"answers":[2,""," ","Yes"]}}}', "answered"],
    ['{"answers":{"q":{"answers":[]}}}', "unavailable"],
    ['{"answers":{"q":null}}', "unavailable"],
    ['{"answers":{"q":{"answers":1}}}', "unavailable"],
    ['{"answers":{}}', "unavailable"],
    ['{"answers":null}', "unavailable"],
    ["was cancelled before receiving a response", "cancelled"],
    [null, "unavailable"],
  ])("retires blocking native output %j as %s", (value, reason) => {
    const { state, registry, listener } = setup();
    state.observe(event(call({ id: "call", queued: false })));
    state.publish([...state.candidates.values()][0]!);
    expect(state.observe(output("call", value))).toBe(true);
    expect(registry.list()).toEqual([]);
    expect(state.candidates.size).toBe(0);
    expect(state.hasReservation()).toBe(false);
    expect(listener).toHaveBeenCalledWith(
      "question",
      expect.objectContaining({ phase: "closed", reason }),
    );
    expect(state.observe(event(call({ id: "call", queued: false })))).toBe(false);
  });
  test("retires queued answers from committed native reply records", () => {
    const { state, registry } = setup();
    const captured = records("async-records.json");
    expect(captured).toHaveLength(7);
    const keys = [0, 1].map((index) => queuedKey("call_c54736dbd68049d192ab5f52ad2532f0", index));
    for (const raw of captured.slice(0, 3)) state.observe({ ...event(undefined), raw });
    expect(
      state.availableAcceptedQueuedCandidates().map((candidate) => candidate.nativeKey),
    ).toEqual(keys);
    for (const candidate of state.unpublishedCandidates()) state.publish(candidate);
    expect(registry.list()).toHaveLength(2);
    state.observe({ ...event(undefined), raw: captured[3] });
    expect(
      state.availableAcceptedQueuedCandidates().map((candidate) => candidate.nativeKey),
    ).toEqual([keys[1]]);
    expect(registry.list()).toHaveLength(1);
    state.observe({ ...event(undefined), raw: captured[4] });
    expect(state.candidates.size).toBe(0);
    expect(registry.list()).toEqual([]);
    for (const raw of [...captured.slice(5), ...captured])
      state.observe({ ...event(undefined), raw });
    expect(state.candidates.size).toBe(0);
    expect(registry.list()).toEqual([]);
  });
  test("ignores non-native activities and invalid envelopes", () => {
    const { state } = setup();
    const native = event(call());
    expect(state.observe({ ...native, agent: "claude" })).toBe(false);
    expect(state.observe({ ...native, source: "terminal" })).toBe(false);
    expect(state.observe({ ...native, raw: null })).toBe(false);
    for (const payload of [
      null,
      { type: "item_completed", item: null },
      { type: "message", role: "user", delivery: "async", questions: [] },
      { type: "agent_message", delivery: "sync", questions: [] },
      { type: "AgentMessage", delivery: "async", questions: null },
      { type: "function_call_output", call_id: 3 },
    ])
      expect(state.observe(event(payload))).toBe(false);
    for (const type of ["agent_message", "message"])
      expect(
        state.observe(event({ type, role: "assistant", delivery: "async", questions: [] })),
      ).toBe(type === "agent_message");
  });
  test("keeps unpublished identity when the registry has shut down", () => {
    const { state, registry } = setup();
    registry.shutdown();
    state.observe(event(call()));
    state.publish([...state.candidates.values()][0]!);
    expect(state.unpublishedCandidates().size).toBe(1);
  });
});

test("retires all native units when a close observer also removes another queued unit", () => {
  const { state, registry } = setup();
  state.observe(
    event({
      type: "AgentMessage",
      id: "call",
      delivery: "async",
      questions: [{ title: "First" }, { title: "Second" }],
    }),
  );
  const candidates = state.availableAcceptedQueuedCandidates();
  expect(candidates).toHaveLength(2);
  const second = candidates[1];
  expect(second).toBeDefined();
  if (!second) throw new Error("Expected the second queued candidate");
  let observerClosedSecond = false;
  for (const candidate of candidates) state.publish(candidate);
  registry.onEvent((edge) => {
    if (edge.phase === "closed" && edge.request.questions[0]!.prompt === "First")
      observerClosedSecond = state.close(second.nativeKey, "unavailable");
  });
  expect(state.observe(output("call", "cancelled"))).toBe(true);
  expect(observerClosedSecond).toBe(true);
  expect(registry.list()).toEqual([]);
});
