/**
 * Claude's boundary reader: `StopFailure` is a rejection that carries no completeness text and
 * belongs only to the submission whose `prompt_id` it names, while `Stop` keeps the default
 * reading (PRD §5.8 / §6.1, C-API-59).
 */

import { expect, test } from "vitest";
import { claudeBoundarySignal } from "../../src/claude/hooks/stop-failure.ts";
import { boundaryExpectation, signalFailure } from "../../src/core/simple/boundary-signal.ts";

/** The reader's failure for a StopFailure payload as Claude 2.1.310 sends it. */
function rejection(fields: { readonly prompt_id?: string; readonly error?: string }) {
  const event = {
    hook_event_name: "StopFailure",
    last_assistant_message: "There's an issue with the selected model.",
    ...fields,
  };
  const signal = claudeBoundarySignal(event);
  const failure = signalFailure(signal);
  // A rejection carries no completeness text and is always correlatable.
  if (!failure?.belongsTo || boundaryExpectation(signal) !== "")
    throw new Error(`not a correlatable textless rejection: ${JSON.stringify(signal)}`);
  return failure;
}

const submit = (prompt_id?: string) => ({
  hook_event_name: "UserPromptSubmit",
  prompt: "go",
  ...(prompt_id === undefined ? {} : { prompt_id }),
});

test("C-API-59 StopFailure is a rejection with the agent's error name, never its error text", () => {
  expect(rejection({ error: "model_not_found" })).toMatchObject({
    message: "Claude rejected the turn: model_not_found",
    agentError: "model_not_found",
  });
  expect(rejection({}).agentError).toBeUndefined();
});

test("C-API-59 a StopFailure belongs only to the submission whose prompt_id it names", () => {
  const failure = rejection({ prompt_id: "p1", error: "model_not_found" });
  expect(failure.belongsTo?.(submit("p1"))).toBe(true);
  expect(failure.belongsTo?.(submit("p2"))).toBe(false); // an earlier turn's late hook
});

test("C-API-59 without a prompt_id on either side the rejection cannot be told apart", () => {
  expect(rejection({}).belongsTo?.(submit("p2"))).toBe(true);
  expect(rejection({ prompt_id: "" }).belongsTo?.(submit("p2"))).toBe(true);
  expect(rejection({ prompt_id: "p1" }).belongsTo?.(submit())).toBe(true);
});

test("C-API-59 Stop and every other hook keep the default boundary reading", () => {
  expect(claudeBoundarySignal({ hook_event_name: "Stop", last_assistant_message: "OK" })).toBe(
    "OK",
  );
  expect(claudeBoundarySignal({ hook_event_name: "Stop", last_assistant_message: null })).toBe("");
  expect(claudeBoundarySignal({ hook_event_name: "Notification" })).toBeUndefined();
});
