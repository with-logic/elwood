/** Only current store-owned candidate views can update native submission state (PRD §4). */
import { expect, test } from "vitest";
import { call, event, setup } from "./candidate-helpers.ts";

test("owned lifecycle operations update readonly views and invalidate pending accepted membership", () => {
  const { state, registry } = setup();
  state.observe(event(call({ id: "owned", accepted: true })));
  const accepted = state.acceptedQueuedCandidates();
  const candidate = accepted[0];
  if (!candidate) throw new Error("Expected an accepted store-owned candidate");
  state.publish(candidate);
  const request = registry.list()[0];
  expect(request).toBeDefined();
  state.setSubmitting(candidate, true);
  expect(candidate.submitting).toBe(true);
  state.setSubmitting(candidate, false);
  expect(candidate.submitting).toBe(false);
  const beforePending = state.acceptedQueuedCandidates();
  expect(beforePending).toEqual([candidate]);
  state.markPendingSubmission(candidate);
  expect(candidate.awaitingNative).toBe(true);
  expect(accepted).toEqual([candidate]);
  expect(state.acceptedQueuedCandidates()).not.toBe(beforePending);
  expect(state.acceptedQueuedCandidates()).toEqual([]);
  expect(registry.list()).toEqual([request]);
  expect(state.hasReservation()).toBe(true);
});

test.each([
  "closed",
  "replaced",
] as const)("a %s candidate cannot mutate a successor or its accepted cache", (retirement) => {
  const { state, registry } = setup();
  state.observe(event(call({ id: "owned", accepted: true })));
  const old = state.acceptedQueuedCandidates()[0];
  if (!old) throw new Error("Expected an accepted original candidate");
  state.publish(old);
  const request = registry.list()[0];
  if (!request) throw new Error("Expected a published original request");
  if (retirement === "closed") state.close(old.nativeKey, "answered");
  state.observe(
    event(
      call({
        id: retirement === "closed" ? "successor" : "owned",
        accepted: true,
        prompt: "Replacement",
      }),
    ),
  );
  expect(registry.get(request.id)).toBeUndefined();
  const accepted = state.acceptedQueuedCandidates();
  const successor = accepted[0];
  if (!successor) throw new Error("Expected an accepted successor candidate");
  expect(successor).not.toBe(old);
  expect(successor.questions[0].definition.prompt).toBe("Replacement");
  state.publish(successor);
  const successorRequests = registry.list();
  expect(successorRequests).toHaveLength(1);
  state.setSubmitting(old, true);
  state.markPendingSubmission(old);
  expect(old.submitting).toBe(false);
  expect(old.awaitingNative).toBe(false);
  expect(successor.submitting).toBe(false);
  expect(successor.awaitingNative).toBe(false);
  expect(state.acceptedQueuedCandidates()).toBe(accepted);
  expect(registry.list()).toEqual(successorRequests);
  expect(state.candidates.get(successor.nativeKey)).toBe(successor);
});
