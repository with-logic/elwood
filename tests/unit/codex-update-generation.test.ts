/**
 * Generation-safety coverage for Codex update retries across split and replaced screens.
 * Covers PRD §5.5 and C-CODEX-12.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { CodexUpdatePromptTracker } from "../../src/codex/update-prompt.ts";

const update = "Update available! 0.153.3 -> 0.153.4\n› 1. Update now\n  2. Skip";

describe("Codex update prompt generations", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("C-CODEX-12 accepts a safe option-only continuation of the current prompt", async () => {
    const responder = new CodexStartupPromptResponder("s1");
    let frame = "Update available! 0.153.3 -> 0.153.4\n  1. Update now";
    responder.handle(frame, () => {});
    frame = "  2. Skip\n  3. Skip until next version";
    const writes: string[] = [];
    const handled = responder.handle(
      frame,
      (input) => {
        writes.push(input);
        frame = "› Ready";
      },
      () => frame,
    );
    await vi.runAllTimersAsync();
    await handled.outcomes[0]?.settled;
    expect(writes).toEqual(["2"]);
  });

  test("C-CODEX-12 an old retry cannot cross a clear-and-reappear generation", async () => {
    const responder = new CodexStartupPromptResponder("s1");
    let frame = update;
    const writes: string[] = [];
    const write = (input: string) => {
      writes.push(input);
      if (input === "3") frame = "› Ready";
    };
    const first = responder.handle(frame, write, () => frame);
    frame = "› Ready";
    responder.handle(frame, write, () => frame);
    frame = update.replace("2. Skip", "3. Skip until next version");
    const second = responder.handle(frame, write, () => frame);

    await vi.runAllTimersAsync();
    await Promise.all([first.outcomes[0]?.settled, second.outcomes[0]?.settled]);
    expect(writes).toEqual(["2", "3"]);
  });

  test("an option-only replacement cannot continue an update generation", () => {
    const tracker = new CodexUpdatePromptTracker();
    expect(tracker.observe(update)).toBe(true);
    const current = tracker.currentFramePredicate();
    expect(tracker.observe("  1. Reset cache\n  2. Later")).toBe(false);
    expect(current("  2. Skip")).toBe(false);
  });
});
