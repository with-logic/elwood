/** Versioned banners own separate retry generations (PRD §5.5, C-CODEX-12/17). */
import { afterEach, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { CodexUpdatePromptTracker } from "../../src/codex/update/tracker.ts";
import { codexSmallComposer } from "../fixtures/trust-composer.ts";

const options = "1. Update now\n2. Skip";
const first = `Update available! 0.153.3 -> 0.153.4\n${options}`;
const next = `Update available! 0.153.4 -> 0.154.0\n${options}`;
afterEach(() => vi.useRealTimers());

test("C-CODEX-12 changed banners supersede captured authority before and after observation", () => {
  const tracker = new CodexUpdatePromptTracker();
  tracker.observe(first);
  const generation = tracker.currentGeneration;
  const original = tracker.currentFramePredicate();
  expect(original(next)).toBe(false);
  tracker.observe(next);
  expect(tracker.hasSupersedingGeneration(generation)).toBe(true);
  expect(original(next)).toBe(false);
  expect(tracker.currentFramePredicate()(next)).toBe(true);
  const fresh = tracker.currentGeneration;
  tracker.observe(options);
  tracker.observe(next);
  expect(tracker.currentGeneration).toBe(fresh);
  expect(tracker.currentFramePredicate()("2. Skip")).toBe(true);
});

test("C-CODEX-12 an unobserved banner replacement stops the pending retry", async () => {
  vi.useFakeTimers();
  let frame = first;
  const writes: string[] = [];
  const responder = new CodexStartupPromptResponder();
  const initial = responder.handle(
    frame,
    (key) => void writes.push(key),
    () => frame,
  );
  frame = next;
  await vi.runAllTimersAsync();
  await expect(initial.outcomes[0]?.settled).resolves.toBe("cancelled");
  expect(writes).toEqual(["2"]);
  responder.dispose();
});

test("C-CODEX-12 an exhausted appearance can start a fresh attempt when its banner changes", async () => {
  vi.useFakeTimers();
  let frame = first;
  const writes: string[] = [];
  const responder = new CodexStartupPromptResponder();
  const write = (key: string) => void writes.push(key);
  const initial = responder.handle(frame, write, () => frame);
  await vi.runAllTimersAsync();
  await expect(initial.outcomes[0]?.settled).resolves.toBe("cancelled");
  expect(writes).toHaveLength(20);
  expect(responder.handle(frame, write, () => frame).outcomes).toEqual([]);
  frame = next;
  const fresh = responder.handle(frame, write, () => frame);
  expect(writes).toHaveLength(21);
  expect(fresh.outcomes).toHaveLength(1);
  frame = codexSmallComposer;
  await vi.runAllTimersAsync();
  await expect(fresh.outcomes[0]?.settled).resolves.toBe("answered");
  responder.dispose();
});

test.each([
  "fulfilled",
  "rejected",
])("C-CODEX-17 changed banners cancel the old %s write quietly", async (result) => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<void>();
  let frame = first;
  const responder = new CodexStartupPromptResponder();
  let oldWrites = 0;
  const old = responder.handle(
    frame,
    () => {
      oldWrites += 1;
      return pending.promise;
    },
    () => frame,
  );
  let oldSettlement: string | undefined;
  void old.outcomes[0]?.settled?.then(
    (value) => {
      oldSettlement = value ?? undefined;
    },
    () => {
      oldSettlement = "rejected";
    },
  );
  frame = next;
  const writes: string[] = [];
  const fresh = responder.handle(
    frame,
    (key) => void writes.push(key),
    () => frame,
  );
  if (result === "fulfilled") pending.resolve();
  else pending.reject(new Error("old write failed"));
  await vi.advanceTimersByTimeAsync(250);
  expect(oldWrites).toBe(1);
  expect(oldSettlement).toBe("cancelled");
  expect(writes.length).toBeGreaterThan(0);
  responder.dispose();
  await fresh.outcomes[0]?.settled;
});
