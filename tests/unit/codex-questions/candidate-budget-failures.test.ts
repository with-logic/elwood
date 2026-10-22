/** Store-level metadata exhaustion closes requests while keeping native automation held (PRD §4). */
import { expect, test } from "vitest";
import { CodexQuestionCandidates } from "../../../src/codex/questions/candidates.ts";
import { questionMetadataLimitBytes } from "../../../src/codex/questions/limits.ts";
import { questionCall } from "../../../src/codex/questions/records.ts";
import { QuestionRegistry } from "../../../src/core/questions/registry.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { call, event, setup } from "./candidate-helpers.ts";

function largeRecord(id: string, bytes: number) {
  return {
    type: "AgentMessage",
    id,
    delivery: "async",
    questions: [{ title: `${id}: ${"x".repeat(bytes)}`, options: ["Yes"] }],
  };
}

test("two individually valid large records exhaust the aggregate store budget and close requests", () => {
  const { state, registry, disabled } = setup();
  const events: ElwoodQuestionEvent[] = [];
  registry.onEvent((edge) => events.push(edge));
  const first = largeRecord("first", 600 * 1024);
  const second = largeRecord("second", 600 * 1024);
  for (const payload of [first, second]) {
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(questionMetadataLimitBytes);
    expect(questionCall(payload)?.questions).toHaveLength(1);
  }
  expect(Buffer.byteLength(JSON.stringify([first, second]))).toBeGreaterThan(
    questionMetadataLimitBytes,
  );
  expect(state.observe(event(first))).toBe(true);
  const candidate = state.availableAcceptedQueuedCandidates()[0];
  if (!candidate)
    throw new Error("First valid record must be accepted before aggregate exhaustion");
  state.publish(candidate);
  const request = registry.list()[0];
  expect(request).toBeDefined();
  expect(state.observe(event(second))).toBe(true);
  expect(events.filter((edge) => edge.phase === "closed")).toEqual([
    { elwoodSessionId: "session", agent: "codex", phase: "closed", request, reason: "unavailable" },
  ]);
  expect(registry.list()).toEqual([]);
  expect(state.candidates.size).toBe(0);
  expect(state.availableAcceptedQueuedCandidates()).toEqual([]);
  expect(state.unpublishedCandidates().size).toBe(0);
  expect(state.hasReservation()).toBe(true);
  expect(disabled).toHaveBeenCalledOnce();
  expect(state.observe(event(call({ id: "after-disable", queued: true, accepted: true })))).toBe(
    false,
  );
  expect(state.candidates.size).toBe(0);
  expect(disabled).toHaveBeenCalledOnce();
});

test("a throwing disable notifier cannot escape a limit-triggered observation or release its hold", () => {
  const registry = new QuestionRegistry("codex", "session", { emit: () => {} });
  let notifications = 0;
  const state = new CodexQuestionCandidates(registry, () => {
    notifications++;
    throw new Error("Diagnostic observer failed");
  });
  state.observe(event(call({ id: "first", queued: true, accepted: true })));
  const candidate = state.availableAcceptedQueuedCandidates()[0];
  if (!candidate) throw new Error("Initial valid candidate must exist");
  state.publish(candidate);
  expect(registry.list()).toHaveLength(1);
  let changed: boolean | undefined;
  expect(() => {
    changed = state.observe(event(largeRecord("oversized", questionMetadataLimitBytes)));
  }).not.toThrow();
  expect(changed).toBe(true);
  expect(notifications).toBe(1);
  expect(registry.list()).toEqual([]);
  expect(state.candidates.size).toBe(0);
  expect(state.unpublishedCandidates().size).toBe(0);
  expect(state.hasReservation()).toBe(true);
  expect(state.observe(event(call({ id: "after-disable", queued: true, accepted: true })))).toBe(
    false,
  );
  expect(state.candidates.size).toBe(0);
  expect(notifications).toBe(1);
});
