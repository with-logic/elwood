/** Current bannered choices authorize selection; bannerless repaints never do (C-CODEX-12, PRD §5.5). */
import { expect, test } from "vitest";
import { CodexUpdatePromptTracker } from "../../src/codex/update/tracker.ts";

const banner = "Update available! 0.153.3 -> 0.153.4";
const complete = `${banner}\n1. Update now\n2. Skip\n3. Skip until next version`;

test.each([
  "2. Skip",
  "1. Update now\n2. Skip",
])("C-CODEX-12 a clipped banner cannot authorize unseen continuation %s", (replacement) => {
  const tracker = new CodexUpdatePromptTracker();
  tracker.observe(`${banner}\n1. Update now`);
  const captured = tracker.currentFramePredicate();
  expect(captured(replacement)).toBe(false);
  tracker.observe(replacement);
  expect(tracker.currentFramePredicate()(replacement)).toBe(false);
  expect(tracker.renewsAttention(complete)).toBe(true);
  tracker.observe(complete);
  expect(captured(complete)).toBe(false);
  expect(tracker.currentFramePredicate()(complete)).toBe(true);
  expect(tracker.currentFramePredicate()("2. Skip")).toBe(false);
});

test("C-CODEX-12 a changed bannered binding owns a fresh generation and grace", () => {
  const tracker = new CodexUpdatePromptTracker();
  tracker.observe(complete);
  const prior = tracker.currentFramePredicate();
  const generation = tracker.currentGeneration;
  const replacement = `${banner}\n1. Update now\n2. Continue without updating`;
  expect(prior(replacement)).toBe(false);
  expect(tracker.renewsAttention(replacement)).toBe(true);
  tracker.observe(replacement);
  expect(tracker.hasSupersedingGeneration(generation)).toBe(true);
  expect(tracker.renewsAttention(replacement)).toBe(false);
  expect(prior(replacement)).toBe(false);
  expect(tracker.currentFramePredicate()(replacement)).toBe(true);
});

test.each([32, 33])("C-CODEX-12 %s retained choices enforce the bounded appearance", (count) => {
  const tracker = new CodexUpdatePromptTracker();
  const options = Array.from({ length: count }, (_, index) => `${index + 1}. Skip`).join("\n");
  tracker.observe(`${banner}\n${options}`);
  expect(tracker.currentFramePredicate()(`${banner}\n${options}`)).toBe(count === 32);
  if (count === 33) {
    tracker.observe(complete);
    expect(tracker.currentFramePredicate()("2. Skip")).toBe(false);
    expect(tracker.renewsAttention(complete)).toBe(false);
  }
});
