/** Disposing Claude startup automation interrupts a stalled render wait (C-API-56/CLAUDE-22). */
import { expect, test, vi } from "vitest";
import {
  ClaudeStartupPromptResponder,
  guardedClaudeAutomationWrite,
} from "../../src/claude/startup-prompts.ts";

const prompt =
  "Claude Code running in a browser?\n❯ 1. Yes, use my browser\n  2. No, keep browser tools off";

test("C-CLAUDE-22 disposal settles a browser decline without releasing the render barrier", async () => {
  vi.useFakeTimers();
  try {
    const responder = new ClaudeStartupPromptResponder(true);
    const write = vi.fn();
    const guarded = guardedClaudeAutomationWrite(
      { sendInput: write, settled: () => new Promise<void>(() => {}) },
      write,
      () => prompt,
      () => responder.closing,
      responder.closingSignal,
    );
    const outcomes = responder.handle(prompt, write, () => prompt, guarded);
    let completion: unknown = "pending";
    void outcomes[0]!.settled!.then((value) => {
      completion = value;
    });
    expect(vi.getTimerCount()).toBe(1);
    responder.dispose();
    // Advance only microtasks: the one-second observation deadline cannot fire.
    await vi.advanceTimersByTimeAsync(0);
    expect(completion).toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
    expect(write).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
