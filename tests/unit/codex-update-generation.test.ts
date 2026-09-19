/**
 * Generation-safety coverage for Codex update retries across split and replaced screens.
 * Covers PRD §5.5 and C-CODEX-12.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";
import { CodexUpdatePromptTracker } from "../../src/codex/update/index.ts";
import { emitSettledStartupOutcomes } from "../../src/core/startup/write.ts";

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

  test("C-CODEX-12 a superseded attempt's late success is not reported for the next generation", async () => {
    const responder = new CodexStartupPromptResponder("s1");
    let frame = update;
    const write = (): void => {};
    const read = () => frame;
    const first = responder.handle(frame, write, read);
    frame = "› Ready";
    responder.handle(frame, write, read);
    frame = update;
    responder.handle(frame, write, read);
    const emit = vi.fn();
    emitSettledStartupOutcomes({ emit }, "codex", "s1", first.outcomes, undefined);
    // The first attempt's next poll sees a newer appearance: no `startup_prompt` for it.
    await vi.advanceTimersByTimeAsync(250);
    await expect(first.outcomes[0]?.settled).resolves.toBe("cancelled");
    expect(emit).not.toHaveBeenCalled();
  });

  test("C-CODEX-12 a superseded attempt's late rejection cannot re-arm or warn for the next generation", async () => {
    const responder = new CodexStartupPromptResponder("s1");
    let rejectFirst = (_error: Error): void => {};
    const pending = () => new Promise<void>((_resolve, reject) => (rejectFirst = reject));
    const first = responder.handle(update, pending, () => update);
    const writes: string[] = [];
    const write = (input: string) => void writes.push(input);
    responder.handle("› Ready", write, () => update);
    const second = responder.handle(update, write, () => update);
    rejectFirst(new Error("pty closed"));
    await expect(first.outcomes[0]?.settled).resolves.toBe("cancelled");
    // The reappeared screen's own attempt is still writing: no overlapping loop starts.
    expect(responder.handle(update, write, () => update).outcomes).toEqual([]);
    await vi.runAllTimersAsync();
    await expect(second.outcomes[0]?.settled).resolves.toBe("cancelled");
    expect(writes).toHaveLength(20);
  });

  // The clear is `observed` by handle(), still `unobserved` (only the live frame shows it),
  // or `unread` (a legacy caller without a live frame reader).
  test.each([
    ["resolves", "observed"],
    ["rejects", "observed"],
    ["rejects", "unobserved"],
    ["rejects", "unread"],
  ] as const)("C-CODEX-17 a pending write that %s after a merely cleared (%s) screen", async (mode, clear) => {
    const responder = new CodexStartupPromptResponder("s1");
    let settle = { resolves: (): void => {}, rejects: (_error: Error): void => {} };
    const pending = () =>
      new Promise<void>((resolves, rejects) => (settle = { resolves, rejects }));
    let frame = update;
    const first = responder.handle(frame, pending, clear === "unread" ? undefined : () => frame);
    frame = "› Ready";
    if (clear !== "unobserved") responder.handle(frame, pending);
    const emit = vi.fn();
    const emitWarnings = vi.fn();
    emitSettledStartupOutcomes({ emit }, "codex", "s1", first.outcomes, { emitWarnings });
    settle[mode](new Error("pty closed"));
    await vi.runAllTimersAsync();
    // Clearing after our key IS success; a failed write with no prompt left to retry
    // or block on is quiet — its warning would fail a healthy CLI run as blocked_prompt.
    const completion = mode === "resolves" ? "answered" : "cancelled";
    await expect(first.outcomes[0]?.settled).resolves.toBe(completion);
    expect(emit).toHaveBeenCalledTimes(mode === "resolves" ? 1 : 0);
    expect(emitWarnings).not.toHaveBeenCalled();
  });

  test("C-CODEX-12 an exhausted skip stays latched until the update screen reappears", async () => {
    const responder = new CodexStartupPromptResponder("s1");
    const writes: string[] = [];
    const write = (input: string) => void writes.push(input);
    const first = responder.handle(update, write, () => update);
    await vi.runAllTimersAsync();
    await expect(first.outcomes[0]?.settled).resolves.toBe("cancelled");
    expect(responder.handle(update, write, () => update).outcomes).toEqual([]);
    await vi.runAllTimersAsync();
    expect(writes).toHaveLength(20);
    // The restart-loop re-arm survives: a cleared frame, then the same screen again.
    responder.handle("› Ready", write, () => update);
    const again = responder.handle(update, write, () => (writes.length > 20 ? "› Ready" : update));
    await vi.runAllTimersAsync();
    await expect(again.outcomes[0]?.settled).resolves.toBe("answered");
    expect(writes).toHaveLength(21);
  });

  test("an option-only replacement cannot continue an update generation", () => {
    const tracker = new CodexUpdatePromptTracker();
    expect(tracker.observe(update)).toBe(true);
    const current = tracker.currentFramePredicate();
    expect(tracker.observe("  1. Reset cache\n  2. Later")).toBe(false);
    expect(current("  2. Skip")).toBe(false);
  });
});
