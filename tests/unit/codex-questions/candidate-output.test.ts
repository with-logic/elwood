/** Complete native output identities govern blocking closure and queued acceptance (PRD §4). */
import { expect, test } from "vitest";
import { queuedKey } from "../../../src/codex/questions/records.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { event, setup } from "./candidate-helpers.ts";
import { records } from "./fixtures.ts";

test.each([
  ["partial", { color: { answers: ["Blue"] } }, "unavailable"],
  ["complete", { color: { answers: ["Blue"] }, note: { answers: ["Short"] } }, "answered"],
] as const)("%s answers close and release a two-ID blocking native call", (_label, answers, reason) => {
  const { state, registry } = setup();
  const events: ElwoodQuestionEvent[] = [];
  registry.onEvent((edge) => events.push(edge));
  const nativeCall = records("blocking-records.json")[0];
  const callId = "call_8aaf11dc88ec4e7cb1d51793fea2de2c";
  expect(state.observe({ ...event(undefined), raw: nativeCall })).toBe(true);
  const candidate = state.candidates.get(callId);
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Captured blocking call did not produce its native candidate");
  expect(candidate).toMatchObject({ nativeKey: callId, queued: false, accepted: false });
  state.publish(candidate);
  const request = registry.list()[0];
  expect(request?.questions).toHaveLength(2);
  expect(
    state.observe(
      event({
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify({ answers }),
      }),
    ),
  ).toBe(true);
  expect(events.filter((edge) => edge.phase === "closed")).toEqual([
    { elwoodSessionId: "session", agent: "codex", phase: "closed", request, reason },
  ]);
  expect(registry.list()).toEqual([]);
  expect(state.candidates.size).toBe(0);
  expect(state.hasReservation()).toBe(false);
});

test("captured accepted output alone accepts the exact queued native identities", () => {
  const { state } = setup();
  const captured = records("async-records.json");
  const callId = "call_c54736dbd68049d192ab5f52ad2532f0";
  const nativeKeys = [queuedKey(callId, 0), queuedKey(callId, 1)];
  expect(state.observe({ ...event(undefined), raw: captured[0] })).toBe(true);
  expect([...state.candidates.keys()]).toEqual(nativeKeys);
  expect(state.acceptedQueuedCandidates()).toEqual([]);
  // Deliberately skip captured[1], the assistant mirror that also reports acceptance.
  expect(state.observe({ ...event(undefined), raw: captured[2] })).toBe(true);
  expect(state.acceptedQueuedCandidates().map(({ nativeKey }) => nativeKey)).toEqual(nativeKeys);
  expect(
    [...state.candidates.values()].map(({ nativeKey, accepted }) => ({ nativeKey, accepted })),
  ).toEqual(nativeKeys.map((nativeKey) => ({ nativeKey, accepted: true })));
});
