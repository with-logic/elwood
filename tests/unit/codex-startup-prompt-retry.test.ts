/**
 * Coverage for retry-on-rejected-write of Codex startup-prompt automation.
 * Covers PRD §5.4/§5.7 (C-CODEX-17): a rejected PTY write leaves the prompt
 * retryable and its `settled` promise rejects, so no false "answered" is emitted.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CodexStartupPromptResponder,
  type SettledCodexStartupOutcome,
} from "../../src/codex/startup-prompts.ts";
import { writeCodexUpdateSkip } from "../../src/codex/update-prompt.ts";

function outcomesOf(settled: readonly SettledCodexStartupOutcome[]) {
  return settled.map((entry) => entry.outcome);
}

async function drain(settled: readonly SettledCodexStartupOutcome[]): Promise<void> {
  await Promise.allSettled(settled.map((entry) => entry.settled));
}

describe("Codex startup prompt retry on rejected write", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("C-CODEX-12 stops retrying as soon as the update screen clears", async () => {
    const prompt = "Update available! 0.153.3 -> 0.153.4\n› 1. Update now\n  2. Skip";
    let frame = prompt;
    const writes: string[] = [];
    const result = writeCodexUpdateSkip(
      "2",
      (input) => {
        writes.push(input);
        frame = "› Ready";
      },
      () => frame,
    );
    await vi.runAllTimersAsync();
    await result;
    expect(writes).toEqual(["2"]);
  });

  test("C-CODEX-12 re-reads a renumbered safe option before every retry", async () => {
    const prompt = "Update available! 0.153.3 -> 0.153.4\n› 1. Update now\n  2. Skip";
    let frame = prompt;
    const writes: string[] = [];
    const result = writeCodexUpdateSkip(
      "2",
      (input) => {
        writes.push(input);
        frame = writes.length === 1 ? `${prompt.replace("2. Skip", "3. Not now")}` : "› Ready";
      },
      () => frame,
    );
    await vi.runAllTimersAsync();
    await result;
    expect(writes).toEqual(["2", "3"]);
  });

  test("C-CODEX-12 never retries into a replacement dialog", async () => {
    const prompt = "Update available! 0.153.3 -> 0.153.4\n› 1. Update now\n  2. Skip";
    let frame = prompt;
    const writes: string[] = [];
    const result = writeCodexUpdateSkip(
      "2",
      (input) => {
        writes.push(input);
        frame = "Enable new context cache?\n  1. Reset cache\n› 2. Later";
      },
      () => frame,
    );
    await vi.runAllTimersAsync();
    await result;
    expect(writes).toEqual(["2"]);
  });

  test("C-CODEX-12 fails if the live update screen loses its safe option", async () => {
    const prompt = "Update available! 0.153.3 -> 0.153.4\n› 1. Update now\n  2. Skip";
    let frame = prompt;
    const result = writeCodexUpdateSkip(
      "2",
      () => {
        frame = "Update available! 0.153.3 -> 0.153.4\n› 1. Update now";
      },
      () => frame,
    );
    const cancellation = expect(result).resolves.toBe("cancelled");
    await vi.runAllTimersAsync();
    await cancellation;
  });

  test("C-CODEX-12 retries a swallowed skip only while its safe option stays visible", async () => {
    const responder = new CodexStartupPromptResponder("s1");
    const prompt = "Update available! 0.153.3 -> 0.153.4\n› 1. Update now\n  2. Skip";
    let frame = prompt;
    const writes: string[] = [];
    const handled = responder.handle(
      prompt,
      (input) => {
        writes.push(input);
        if (writes.length === 2) frame = "› Ready";
      },
      () => frame,
    );
    const settled = handled.outcomes[0]?.settled;
    await vi.runAllTimersAsync();
    await settled;
    expect(writes).toEqual(["2", "2"]);
  });

  test("C-CODEX-12 bounds retries when the safe update option never clears", async () => {
    const writes: string[] = [];
    const result = writeCodexUpdateSkip(
      "2",
      (input) => {
        writes.push(input);
      },
      () => "Update available! 0.153.3 -> 0.153.4\n  1. Update now\n› 2. Skip",
    );
    const cancellation = expect(result).resolves.toBe("exhausted");
    await vi.runAllTimersAsync();
    await cancellation;
    expect(writes).toHaveLength(20);
  });

  test("C-CODEX-17 a REJECTED update-skip write stays retryable and never resolves as answered", async () => {
    const responder = new CodexStartupPromptResponder("s1");
    const frame = "Update available\n  1. Update now\n  2. Continue without updating";
    // The write is rejected: the skip must NOT settle, and its `settled` promise
    // must reject (so the caller warns rather than reporting a false "answered"),
    // leaving the update prompt for a later frame to re-attempt.
    const rejecting = responder.handle(frame, () => Promise.reject(new Error("pty closed")));
    expect(outcomesOf(rejecting.outcomes)).toEqual([
      { kind: "attempted", prompt: "update", input: "2" },
    ]);
    await expect(rejecting.outcomes[0]?.settled).rejects.toThrow("pty closed");
    // Retryable: the next frame re-attempts the skip with a fulfilling write.
    const writes: string[] = [];
    const retried = responder.handle(frame, (input) => {
      writes.push(input);
    });
    expect(outcomesOf(retried.outcomes)).toEqual([
      { kind: "attempted", prompt: "update", input: "2" },
    ]);
    expect(writes).toEqual(["2"]);
    await drain(retried.outcomes);
  });

  test("C-CODEX-17 a REJECTED directory-trust write leaves the trust prompt retryable", async () => {
    const responder = new CodexStartupPromptResponder("s1", true);
    const frame = "Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit";
    const rejecting = responder.handle(frame, () => Promise.reject(new Error("pty closed")));
    await expect(rejecting.outcomes[0]?.settled).rejects.toThrow("pty closed");
    const writes: string[] = [];
    const retried = responder.handle(frame, (input) => {
      writes.push(input);
    });
    expect(outcomesOf(retried.outcomes)).toEqual([
      { kind: "attempted", prompt: "workspace_trust", input: "1" },
    ]);
    expect(writes).toEqual(["1\r"]);
    await drain(retried.outcomes);
  });
});
