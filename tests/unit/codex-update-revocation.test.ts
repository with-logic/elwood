/** Ambiguous update frames irrevocably cancel their attempt (PRD §5.5, C-CODEX-12). */
import { afterEach, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { CodexUpdatePromptTracker } from "../../src/codex/update/tracker.ts";
import { codexSmallComposer } from "../fixtures/trust-composer.ts";

const options = "  1. Update now\n  2. Skip";
const update = `Update available! 0.153.3 -> 0.153.4\n${options}`;
const ambiguous = `${update}\nConfirm archive removal?`;
afterEach(() => vi.useRealTimers());

test("C-CODEX-12 ambiguity permanently revokes a captured predicate until fresh banner evidence", () => {
  const tracker = new CodexUpdatePromptTracker();
  tracker.observe(update);
  const original = tracker.currentFramePredicate();
  const generation = tracker.currentGeneration;
  tracker.observe(ambiguous);
  const revoked = tracker.currentGeneration;
  tracker.observe(ambiguous);
  tracker.observe(options);
  expect(tracker.currentGeneration).toBe(revoked);
  expect(original(options)).toBe(false);
  expect(tracker.currentFramePredicate()(options)).toBe(false);
  expect(tracker.hasSupersedingGeneration(generation)).toBe(true);
  tracker.observe(update);
  expect(original(update)).toBe(false);
  expect(tracker.currentFramePredicate()(options)).toBe(true);
});

test("C-CODEX-12 a queued retry cannot revive after an ambiguous repaint and bannerless options", async () => {
  vi.useFakeTimers();
  const responder = new CodexStartupPromptResponder("s1");
  let frame = update;
  const writes: string[] = [];
  const write = (key: string) => void writes.push(key);
  const observe = () => responder.handle(frame, write, () => frame);
  const first = observe();
  expect(writes).toEqual(["2"]);
  frame = ambiguous;
  observe();
  frame = options;
  observe();
  await vi.runAllTimersAsync();
  await expect(first.outcomes[0]?.settled).resolves.toBe("cancelled");
  expect(writes).toEqual(["2"]);
  frame = update;
  const fresh = observe();
  expect(writes).toEqual(["2", "2"]);
  frame = codexSmallComposer;
  await vi.runAllTimersAsync();
  await expect(fresh.outcomes[0]?.settled).resolves.toBe("answered");
});

test("C-CODEX-12 ambiguity before the first choice needs a fresh banner even across blank frames", () => {
  const tracker = new CodexUpdatePromptTracker();
  tracker.observe(ambiguous);
  tracker.observe("");
  tracker.observe(options);
  expect(tracker.currentFramePredicate()(options)).toBe(false);
  tracker.observe(update);
  expect(tracker.currentFramePredicate()(options)).toBe(true);
});

test("C-CODEX-12 a readerless caller cannot start an ineligible bannerless attempt", async () => {
  const responder = new CodexStartupPromptResponder("s1");
  const write = vi.fn();
  responder.handle(ambiguous, write);
  await Promise.resolve();
  expect(responder.handle(options, write).outcomes).toEqual([]);
  expect(write).not.toHaveBeenCalled();
  expect(responder.handle(update, write).outcomes).toHaveLength(1);
  expect(write).toHaveBeenCalledExactlyOnceWith("2", expect.any(Function));
});

test.each([
  "resolve",
  "reject",
] as const)("C-CODEX-12 an ambiguous replacement retires a pending write before its late %s", async (mode) => {
  vi.useFakeTimers();
  const responder = new CodexStartupPromptResponder("s1");
  const pending = Promise.withResolvers<void>();
  let frame = update;
  const first = responder.handle(
    frame,
    () => pending.promise,
    () => frame,
  );
  frame = ambiguous;
  responder.handle(frame, () => {});
  frame = codexSmallComposer;
  responder.observeClearance(frame);
  if (mode === "resolve") pending.resolve();
  else pending.reject(new Error("late write rejection"));
  await vi.runAllTimersAsync();
  await expect(first.outcomes[0]?.settled).resolves.toBe("cancelled");
});
