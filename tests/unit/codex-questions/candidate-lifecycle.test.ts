/** Native acceptance, retirement, and observer isolation for PRD §4 catalogs. */
import { describe, expect, test } from "vitest";
import { queuedKey } from "../../../src/codex/questions/records.ts";
import { call, event, setup } from "./candidate-helpers.ts";
import { records } from "./fixtures.ts";

function output(callId: string, value: unknown) {
  return event({ type: "function_call_output", call_id: callId, output: value });
}
describe("candidate native lifecycle", () => {
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
    state.observe(event(call("call", false)));
    state.publish([...state.candidates.values()][0]!);
    expect(state.observe(output("call", value))).toBe(true);
    expect(registry.list()).toEqual([]);
    expect(listener).toHaveBeenCalledWith(
      "question",
      expect.objectContaining({ phase: "closed", reason }),
    );
    expect(state.observe(event(call("call", false)))).toBe(false);
  });
  test("retires queued answers from committed native reply records", () => {
    const { state, registry } = setup();
    const captured = records("async-records.json");
    expect(captured).toHaveLength(7);
    const keys = [0, 1].map((index) => queuedKey("call_c54736dbd68049d192ab5f52ad2532f0", index));
    for (const raw of captured.slice(0, 3)) state.observe({ ...event(undefined), raw });
    expect(state.acceptedQueuedCandidates().map((candidate) => candidate.key)).toEqual(keys);
    for (const candidate of state.unpublishedCandidates()) state.publish(candidate);
    expect(registry.list()).toHaveLength(2);
    state.observe({ ...event(undefined), raw: captured[3] });
    expect(state.acceptedQueuedCandidates().map((candidate) => candidate.key)).toEqual([keys[1]]);
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
  const candidates = state.acceptedQueuedCandidates();
  for (const candidate of candidates) state.publish(candidate);
  registry.onEvent((edge) => {
    if (edge.phase === "closed" && edge.request.questions[0]!.prompt === "First")
      state.close(candidates[1]!.key, "unavailable");
  });
  expect(state.observe(output("call", "cancelled"))).toBe(true);
  expect(registry.list()).toEqual([]);
});
