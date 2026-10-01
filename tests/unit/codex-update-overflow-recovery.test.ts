/** Fresh bounded replacements retire overflow without restarting redraws (C-CODEX-12). */
import { afterEach, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { CodexUpdatePromptTracker } from "../../src/codex/update/tracker.ts";

const banner = "Update available! 0.155.1 -> 0.156.1";
const full = `${banner}\n1. Update now\n2. Skip`;
const overflow = `${banner}\n${Array.from({ length: 33 }, (_, i) => `${i + 1}. Skip`).join("\n")}`;
afterEach(() => vi.useRealTimers());
test.each([
  "exhausted action-only",
  "active overflow",
  "initial overflow",
  "changed-version overflow",
])("C-CODEX-12 fresh bounded block rearms after %s", async (kind) => {
  vi.useFakeTimers();
  let frame = kind === "initial overflow" ? overflow : full;
  const writes: string[] = [];
  const outcomes: Promise<unknown>[] = [];
  const responder = new CodexStartupPromptResponder();
  const tracker = new CodexUpdatePromptTracker();
  const observe = () => {
    tracker.observe(frame);
    const result = responder.handle(
      frame,
      (key) => {
        writes.push(key);
      },
      () => frame,
    );
    for (const outcome of result.outcomes) if (outcome.settled) outcomes.push(outcome.settled);
    return result;
  };
  try {
    observe();
    const previous = tracker.currentFramePredicate();
    if (kind === "exhausted action-only") {
      await vi.runAllTimersAsync();
      expect(writes).toHaveLength(20);
      frame = `${banner}\n1. Update now`;
    } else frame = overflow;
    observe();
    expect(previous(frame)).toBe(false);
    const oldCount = writes.length;
    frame = kind === "changed-version overflow" ? full.replace("0.156.1", "0.157.1") : full;
    const renews = tracker.renewsAttention(frame);
    const fresh = observe();
    expect.soft(renews).toBe(true);
    expect.soft(fresh.updateGeneration).toBeDefined();
    expect.soft(writes.slice(oldCount)).toEqual(["2"]);
    expect.soft(tracker.currentFramePredicate()(frame)).toBe(true);
  } finally {
    responder.dispose();
    await vi.runAllTimersAsync();
    await Promise.allSettled(outcomes);
  }
});

test("C-CODEX-12 invalid overflow replacements cannot renew grace and a recovered redraw stays exhausted", async () => {
  vi.useFakeTimers();
  const responder = new CodexStartupPromptResponder();
  const tracker = new CodexUpdatePromptTracker();
  const writes: string[] = [];
  const outcomes: Promise<unknown>[] = [];
  let frame = overflow;
  const observe = () => {
    tracker.observe(frame);
    const result = responder.handle(
      frame,
      (key) => {
        writes.push(key);
      },
      () => frame,
    );
    for (const outcome of result.outcomes) if (outcome.settled) outcomes.push(outcome.settled);
    return result;
  };
  try {
    observe();
    for (const replacement of [
      overflow,
      banner,
      `${banner}\n1. Update now`,
      "2. Skip",
      "Unknown replacement",
    ]) {
      frame = replacement;
      expect(tracker.renewsAttention(frame)).toBe(false);
      expect(observe().updateGeneration).toBeUndefined();
      expect(writes).toEqual([]);
    }
    frame = full;
    expect(tracker.renewsAttention(frame)).toBe(true);
    expect(observe().updateGeneration).toBeDefined();
    await vi.runAllTimersAsync();
    expect(writes).toHaveLength(20);
    for (let redraw = 0; redraw < 10; redraw += 1) {
      expect(tracker.renewsAttention(frame)).toBe(false);
      expect(observe().updateGeneration).toBeUndefined();
    }
    expect(writes).toHaveLength(20);
  } finally {
    responder.dispose();
    await vi.runAllTimersAsync();
    await Promise.allSettled(outcomes);
  }
});
