/** Reentrant native definition authority survives observer callbacks (PRD §4). */
import { expect, test } from "vitest";
import { event, setup } from "./candidate-helpers.ts";

function message(prompts: readonly string[], id = "call") {
  return event({
    type: "AgentMessage",
    id,
    delivery: "async",
    questions: prompts.map((title) => ({ title })),
  });
}

const scenarios = ["unsupported", "replacement"] as const;
type Scenario = (typeof scenarios)[number];
function assertNever(value: never): never {
  throw new Error(`Unhandled authority scenario: ${value}`);
}
function reentry(evidence: Scenario) {
  switch (evidence) {
    case "replacement":
      return {
        input: message(["Latest", "Retired index", "Latest third"]),
        expected: ["Latest", "Latest third"],
      };
    case "unsupported":
      return { input: message([]), expected: [] };
    default:
      return assertNever(evidence);
  }
}

test.each(scenarios)("retains reentrant %s authority over an older replacement", (evidence) => {
  const { state, registry } = setup();
  const scenario = reentry(evidence);
  state.observe(message(["First", "Removed", "Retained by newer authority"]));
  for (const candidate of state.unpublishedCandidates()) state.publish(candidate);
  expect(registry.list()).toHaveLength(3);
  let observed = false;
  registry.onEvent((edge) => {
    if (edge.phase !== "closed" || edge.request.questions[0]?.prompt !== "Removed") return;
    observed = true;
    state.observe(scenario.input);
  });
  expect(state.observe(message(["Stale"]))).toBe(true);
  expect(observed).toBe(true);
  const { expected } = scenario;
  expect(
    [...state.candidates.values()].map((candidate) => candidate.questions[0]?.definition.prompt),
  ).toEqual(expected);
  for (const candidate of state.unpublishedCandidates()) state.publish(candidate);
  expect(registry.list().map((request) => request.questions[0]?.prompt)).toEqual(expected);
  expect(state.hasReservation()).toBe(true);
});

test("does not supersede an older replacement when a callback observes an unrelated call", () => {
  const { state, registry } = setup();
  state.observe(message(["First", "Removed"]));
  for (const candidate of state.unpublishedCandidates()) state.publish(candidate);
  let observed = false;
  registry.onEvent((edge) => {
    if (edge.phase !== "closed" || edge.request.questions[0]?.prompt !== "Removed") return;
    observed = true;
    state.observe(message(["Independent"], "other"));
  });
  state.observe(message(["Changed"]));
  expect(observed).toBe(true);
  expect(
    [...state.candidates.values()].map((candidate) => candidate.questions[0]?.definition.prompt),
  ).toEqual(["Changed", "Independent"]);
});

test("does not resurrect a new group after unsupported reentry closes its predecessor", () => {
  const { state, registry } = setup();
  state.observe(message(["First"]));
  for (const candidate of state.unpublishedCandidates()) state.publish(candidate);
  expect(registry.list()).toHaveLength(1);
  let observed = false;
  registry.onEvent((edge) => {
    if (edge.phase !== "closed" || edge.request.questions[0]?.prompt !== "First") return;
    observed = true;
    state.observe(message([]));
  });
  expect(state.observe(message(["Changed", "Added"]))).toBe(true);
  expect(observed).toBe(true);
  expect(state.candidates.size).toBe(0);
  expect(state.unpublishedCandidates().size).toBe(0);
  expect(registry.list()).toEqual([]);
  expect(state.hasReservation()).toBe(true);
});

test("numeric call IDs cannot supersede an active string-call replacement", () => {
  const { state, registry } = setup();
  state.observe(message(["First", "Removed"], "3"));
  for (const candidate of state.unpublishedCandidates()) state.publish(candidate);
  let observed = false;
  registry.onEvent((edge) => {
    if (edge.phase !== "closed" || edge.request.questions[0]?.prompt !== "Removed") return;
    observed = true;
    state.observe(
      event({
        type: "function_call",
        name: "request_user_input_async",
        call_id: 3,
        arguments: JSON.stringify({ questions: [{ title: "Malformed numeric identity" }] }),
      }),
    );
  });
  expect(state.observe(message(["Changed"], "3"))).toBe(true);
  expect(observed).toBe(true);
  expect(
    [...state.candidates.values()].map((candidate) => ({
      callId: candidate.callId,
      prompt: candidate.questions[0]?.definition.prompt,
    })),
  ).toEqual([{ callId: "3", prompt: "Changed" }]);
  for (const candidate of state.unpublishedCandidates()) state.publish(candidate);
  expect(registry.list().map((request) => request.questions[0]?.prompt)).toEqual(["Changed"]);
  expect(state.hasReservation()).toBe(true);
});
