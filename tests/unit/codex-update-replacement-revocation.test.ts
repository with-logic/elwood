/** Unknown replacement frames cannot rearm update attempts (PRD §5.5, C-CODEX-12). */
import { afterEach, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";

import { CodexUpdatePromptTracker } from "../../src/codex/update/tracker.ts";
import { codexSmallComposer } from "../fixtures/trust-composer.ts";

const options = "  1. Update now\n  2. Skip";
const update = `Update available! 0.153.3 -> 0.153.4\n${options}`;
afterEach(() => vi.useRealTimers());

test.each([
  "Confirm archive removal?",
  "",
  "  1. Update now\n    Confirm archive removal?",
])("C-CODEX-12 unknown replacement cannot rearm a later bannerless action block: %s", async (replacement) => {
  vi.useFakeTimers();
  const responder = new CodexStartupPromptResponder("s1");
  let frame = update;
  const writes: string[] = [];
  const observe = () =>
    responder.handle(
      frame,
      (key) => void writes.push(key),
      () => frame,
    );
  const first = observe();
  expect(writes).toEqual(["2"]);
  frame = replacement;
  observe();
  frame = options;
  const resumed = observe();
  await vi.runAllTimersAsync();
  await expect(first.outcomes[0]?.settled).resolves.toBe("cancelled");
  expect(writes).toEqual(["2"]);
  expect(resumed.outcomes).toEqual([]);
  frame = update;
  expect(observe().outcomes).toHaveLength(1);
  expect(writes).toEqual(["2", "2"]);
  responder.dispose();
  await vi.runAllTimersAsync();
});

test("C-CODEX-12 fresh banner evidence cannot revive either captured revoked predicate", () => {
  const tracker = new CodexUpdatePromptTracker();
  tracker.observe(update);
  const original = tracker.currentFramePredicate();
  const generation = tracker.currentGeneration;
  tracker.observe("Confirm archive removal?");
  expect(tracker.hasSupersedingGeneration(generation)).toBe(true);
  tracker.observe(options);
  const revoked = tracker.currentFramePredicate();
  expect(revoked(options)).toBe(false);
  tracker.observe(update);
  expect(original(update)).toBe(false);
  expect(revoked(update)).toBe(false);
  expect(tracker.currentFramePredicate()(options)).toBe(true);
});

test("C-CODEX-12 a readerless caller cannot rearm a revoked bannerless prompt", () => {
  const responder = new CodexStartupPromptResponder("s1");
  const write = vi.fn();
  responder.handle(update, write);
  responder.handle("Confirm archive removal?", write);
  expect(responder.handle(options, write).outcomes).toEqual([]);
  expect(write).toHaveBeenCalledTimes(1);
  responder.dispose();
});

test.each([
  "resolve",
  "reject",
] as const)("C-CODEX-12 unknown replacement retires a pending write before late %s and composer clearance", async (mode) => {
  vi.useFakeTimers();
  const responder = new CodexStartupPromptResponder("s1");
  const pending = Promise.withResolvers<void>();
  let frame = update;
  const first = responder.handle(
    frame,
    () => pending.promise,
    () => frame,
  );
  frame = "Confirm archive removal?";
  responder.handle(frame, () => {});
  frame = codexSmallComposer;
  responder.observeClearance(frame);
  if (mode === "resolve") pending.resolve();
  else pending.reject(new Error("late write rejection"));
  await vi.runAllTimersAsync();
  await expect(first.outcomes[0]?.settled).resolves.toBe("cancelled");
});
