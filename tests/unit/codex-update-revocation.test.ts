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

test.each([
  false,
  true,
])("C-CODEX-12 initial ambiguity needs a fresh banner (intervening blank: %s)", (blank) => {
  const tracker = new CodexUpdatePromptTracker();
  tracker.observe(ambiguous);
  if (blank) tracker.observe("");
  tracker.observe(options);
  expect(tracker.currentFramePredicate()(options)).toBe(false);
  tracker.observe(update);
  expect(tracker.currentFramePredicate()(options)).toBe(true);
});

test.each([
  "",
  "\n  1. Update now",
])("C-CODEX-12 a partial fresh banner cannot restore revoked choices (%s)", (partial) => {
  const tracker = new CodexUpdatePromptTracker();
  tracker.observe(update);
  tracker.observe(ambiguous);
  const revoked = tracker.currentGeneration;
  const banner = `Update available! 0.153.3 -> 0.153.4${partial}`;
  expect(tracker.renewsAttention(banner)).toBe(false);
  tracker.observe(banner);
  tracker.observe(options);
  expect(tracker.currentGeneration).toBe(revoked);
  expect(tracker.currentFramePredicate()(options)).toBe(false);
  expect(tracker.renewsAttention(update)).toBe(true);
  tracker.observe(update);
  expect(tracker.currentFramePredicate()(options)).toBe(true);
});
