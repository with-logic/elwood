/** Positive continuation provenance and completion (PRD §5.5, C-CODEX-12/22). */
import { afterEach, expect, test, vi } from "vitest";
import { codexScreenFactTableForTrustPolicy } from "../../src/codex/screen-table.ts";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { CodexUpdatePromptTracker } from "../../src/codex/update/tracker.ts";
import { readScreenFacts } from "../../src/core/screen-facts.ts";

const banner = "Update available! 0.151.0 -> 0.152.0\n  1. Update now";
afterEach(() => vi.useRealTimers());

test.each([
  "  2. Skip backup\n  3. Skip",
  "  2. Skip\n  3. Skip until next version",
])("C-CODEX-22 unseen continuation bindings stay held without receiving a skip: %s", async (replacement) => {
  vi.useFakeTimers();
  const responder = new CodexStartupPromptResponder("s1");
  const writes: string[] = [];
  const writer = (key: string) => {
    writes.push(key);
  };
  responder.handle(banner, writer);
  const result = responder.handle(replacement, writer, () => replacement);
  await vi.runAllTimersAsync();
  await Promise.all(result.outcomes.map((outcome) => outcome.settled));
  expect(writes).toEqual([]);
  const tracker = new CodexUpdatePromptTracker();
  tracker.observe(banner);
  expect(tracker.observe(replacement)).toBe(false);
  const table = codexScreenFactTableForTrustPolicy(false);
  readScreenFacts(table, { text: banner });
  expect(readScreenFacts(table, { text: replacement }).facts.blocking_prompt_visible).toBe(true);
});

test("C-CODEX-22 a known choice cannot vouch for another previously unseen choice", () => {
  const tracker = new CodexUpdatePromptTracker();
  tracker.observe(`${banner}\n  2. Skip`);
  expect(tracker.observe("  2. Skip\n  3. Skip backup")).toBe(false);
});

test("C-CODEX-12 evidence overflow cancels an in-flight skip without false success", async () => {
  vi.useFakeTimers();
  const responder = new CodexStartupPromptResponder("s1");
  let frame = `${banner}\n  2. Skip`;
  const writes: string[] = [];
  const first = responder.handle(
    frame,
    (key) => {
      writes.push(key);
    },
    () => frame,
  );
  expect(writes).toEqual(["2"]);
  frame = `${frame}\n  3. ${"x".repeat(201)}`;
  responder.handle(
    frame,
    () => {},
    () => frame,
  );
  await vi.runAllTimersAsync();
  await expect(first.outcomes[0]?.settled).resolves.toBe("cancelled");
  expect(writes).toEqual(["2"]);
});

test("C-CODEX-22 evidence overflow stays latched through first-party repaints", () => {
  const tracker = new CodexUpdatePromptTracker();
  tracker.observe(`${banner}\n  2. ${"x".repeat(201)}`);
  const generation = tracker.currentGeneration;
  const repaint = `${banner}\n  2. Skip`;
  tracker.observe(repaint);
  expect(tracker.currentGeneration).toBe(generation);
  expect(tracker.currentFramePredicate()(repaint)).toBe(false);
  const next = repaint.replace("0.151.0 -> 0.152.0", "0.152.0 -> 0.153.0");
  tracker.observe(next);
  expect(tracker.currentFramePredicate()(next)).toBe(true);
});
