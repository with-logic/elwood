/** Observer failures follow independent catalog work without losing native ownership (PRD §4). */
import { expect, test, vi } from "vitest";
import { CodexQuestionCandidates } from "../../../src/codex/questions/candidates.ts";
import {
  QuestionNotificationErrors,
  QuestionObserverFailure,
} from "../../../src/core/questions/notification-errors.ts";
import { QuestionRegistry } from "../../../src/core/questions/registry.ts";
import type { ElwoodQuestionEvent } from "../../../src/core/questions/types.ts";
import { TypedEmitter } from "../../../src/events/emitter.ts";
import { call, event, setup } from "./candidate-helpers.ts";

function failureOf(operation: () => void): QuestionObserverFailure {
  try {
    operation();
  } catch (error) {
    if (error instanceof QuestionObserverFailure) return error;
    throw error;
  }
  throw new Error("Expected an observer failure");
}
function publishAll(state: CodexQuestionCandidates): void {
  state.batchNotifications(() => {
    for (const candidate of state.unpublishedCandidates()) state.publish(candidate);
  });
}
function twoCandidates(state: CodexQuestionCandidates): void {
  for (const id of ["first", "second"])
    state.observe(event(call({ id, queued: true, accepted: true })));
}

test("publishes every independent candidate and keeps publication before surfacing the first failure", () => {
  const { state, registry, listener } = setup();
  twoCandidates(state);
  const original = new Error("observer");
  let notifications = 0;
  registry.onEvent(() => {
    throw notifications++ === 0 ? original : new Error("later observer");
  });
  expect(failureOf(() => publishAll(state)).originalError).toBe(original);
  expect(registry.list()).toHaveLength(2);
  expect([...state.candidates.values()].every((candidate) => candidate.published)).toBe(true);
  expect(state.unpublishedCandidates().size).toBe(0);
  expect(listener).toHaveBeenCalledTimes(4);
  for (const request of registry.list())
    expect(listener).toHaveBeenCalledWith(
      "activity",
      expect.objectContaining({ question: expect.objectContaining({ request }) }),
    );
  expect(() => publishAll(state)).not.toThrow();
});

test("direct publication and closure preserve thrown undefined after their registry mutations", () => {
  const { state, registry } = setup();
  twoCandidates(state);
  registry.onEvent(() => {
    // biome-ignore lint/style/useThrowOnlyError: Native observers may throw any value.
    throw undefined;
  });
  const candidate = state.acceptedQueuedCandidates()[0]!;
  expect(failureOf(() => state.publish(candidate)).originalError).toBeUndefined();
  expect(candidate.published).toBe(true);
  expect(
    failureOf(() => state.close(candidate.nativeKey, "answered")).originalError,
  ).toBeUndefined();
  expect(registry.find(candidate.nativeKey)).toBeUndefined();
  expect(state.candidates.has(candidate.nativeKey)).toBe(false);
});

test("turn end closes every candidate and releases reservations before reporting an observer failure", () => {
  const { state, registry } = setup();
  twoCandidates(state);
  publishAll(state);
  const original = new Error("close observer");
  registry.onEvent(() => {
    throw original;
  });
  expect(failureOf(() => state.observe(event({ type: "turn_complete" }))).originalError).toBe(
    original,
  );
  expect(registry.list()).toEqual([]);
  expect(state.candidates.size).toBe(0);
  expect(state.hasReservation()).toBe(false);
});

test("valid replacement reconciliation survives observer failure without disabling the catalog", () => {
  const { state, registry, disabled } = setup();
  twoCandidates(state);
  publishAll(state);
  registry.onEvent(() => {
    throw new Error("replacement observer");
  });
  failureOf(() =>
    state.observe(event(call({ id: "first", queued: true, accepted: true, prompt: "Changed" }))),
  );
  expect(state.candidates.size).toBe(2);
  expect(disabled).not.toHaveBeenCalled();
  expect(
    [...state.candidates.values()].map((candidate) => candidate.questions[0]!.definition.prompt),
  ).toEqual(["Changed", "Pick"]);
});

test("disablement finishes all closures and its notifier before reporting registry failures", () => {
  const notify = vi.fn(() => {
    throw new Error("notifier intentionally contained");
  });
  const registry = new QuestionRegistry("codex", "session", { emit: () => undefined });
  const state = new CodexQuestionCandidates(registry, notify);
  twoCandidates(state);
  publishAll(state);
  const original = new Error("close observer");
  registry.onEvent(() => {
    throw original;
  });
  // Every identity is bounded; exhausting tombstones triggers permanent disablement.
  for (let index = 0; index < 4096; index++) state.close(`retired-${index}`, "answered");
  expect(failureOf(() => state.close("overflow", "answered")).originalError).toBe(original);
  expect(registry.list()).toEqual([]);
  expect(state.candidates.size).toBe(0);
  expect(state.hasReservation()).toBe(true);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(state.close("overflow", "answered")).toBe(false);
});

test("nested notifications reset after failure and preserve primary operation exceptions", () => {
  const errors = new QuestionNotificationErrors();
  const original = new Error("observer");
  const primary = new Error("primary operation");
  const visited: string[] = [];
  expect(() =>
    errors.run(() => {
      errors.capture(() => {
        throw original;
      });
      errors.run(() =>
        errors.capture(() => {
          throw new Error("later observer");
        }),
      );
      visited.push("independent work");
      throw primary;
    }),
  ).toThrow(primary);
  expect(visited).toEqual(["independent work"]);
  expect(errors.run(() => "reset")).toBe("reset");
  expect(
    failureOf(() =>
      errors.capture(() => {
        // biome-ignore lint/style/useThrowOnlyError: Native observers may throw any value.
        throw undefined;
      }),
    ).originalError,
  ).toBeUndefined();
  expect(errors.run(() => "reset again")).toBe("reset again");
});

test("the existing emitter observer boundary contains consumer failures without a duplicate store throw", () => {
  const emitter = new TypedEmitter<{ question: ElwoodQuestionEvent; activity: unknown }>();
  const original = new Error("consumer");
  emitter.on("question", () => {
    throw original;
  });
  const report = vi.fn();
  const registry = new QuestionRegistry("codex", "session", emitter);
  const state = new CodexQuestionCandidates(registry);
  twoCandidates(state);
  expect(() => emitter.observeErrors(report, () => publishAll(state))).not.toThrow();
  expect(report).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenCalledWith(original);
  expect(registry.list()).toHaveLength(2);
});
