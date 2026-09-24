/** Update generations wait for current-frame authoritative clearance (PRD §5.5, C-CODEX-12/17). */
import { expect, test, vi } from "vitest";
import { CodexUpdatePromptTracker } from "../../src/codex/update/tracker.ts";
import { codexSmallComposer } from "../fixtures/trust-composer.ts";

const options = "1. Update now\n2. Skip";
const update = `Update available! 0.153.3 -> 0.153.4\n${options}`;

test("C-CODEX-12 live clearance waits for classification and repeated refresh cannot revive it", () => {
  const staticClearance = vi.fn(() => true);
  const tracker = new CodexUpdatePromptTracker(staticClearance, true);
  tracker.observe(update);
  const generation = tracker.currentGeneration;
  const original = tracker.currentFramePredicate();
  tracker.observe(codexSmallComposer);
  expect(staticClearance).not.toHaveBeenCalled();
  expect(tracker.currentGeneration).toBe(generation + 1);
  expect(original(options)).toBe(false);
  tracker.observeClearance(false);
  expect(tracker.hasSupersedingGeneration(generation)).toBe(true);
  const revoked = tracker.currentGeneration;
  tracker.observeClearance(false);
  tracker.observeClearance(true);
  expect(tracker.currentGeneration).toBe(revoked);
  tracker.observe(options);
  expect(tracker.currentFramePredicate()(options)).toBe(true);
  expect(original(options)).toBe(false);
});

test("C-CODEX-12 a missing authoritative callback revokes before the next frame", () => {
  const tracker = new CodexUpdatePromptTracker(() => true, true);
  tracker.observe(update);
  const generation = tracker.currentGeneration;
  tracker.observe(codexSmallComposer);
  tracker.observe("still an unknown replacement");
  expect(tracker.hasSupersedingGeneration(generation)).toBe(true);
  tracker.observe(options);
  expect(tracker.currentFramePredicate()(options)).toBe(false);
});

test.each([
  false,
  true,
])("C-CODEX-17 standalone tracking honors injected clearance (%s)", (cleared) => {
  const tracker = new CodexUpdatePromptTracker(() => cleared);
  tracker.observe(update);
  const generation = tracker.currentGeneration;
  tracker.observe("custom clearance surface");
  expect(tracker.hasSupersedingGeneration(generation)).toBe(!cleared);
  tracker.observe(options);
  expect(tracker.currentFramePredicate()(options)).toBe(cleared);
});
