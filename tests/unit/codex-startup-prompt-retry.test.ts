/**
 * Coverage for retry-on-rejected-write of Codex startup-prompt automation.
 * Covers PRD §5.4/§5.7 (C-CODEX-17): a rejected PTY write leaves the prompt
 * retryable and its `settled` promise rejects, so no false "answered" is emitted.
 */

import { describe, expect, test } from "vitest";
import {
  CodexStartupPromptResponder,
  type SettledCodexStartupOutcome,
} from "../../src/codex/startup-prompts.ts";

function outcomesOf(settled: readonly SettledCodexStartupOutcome[]) {
  return settled.map((entry) => entry.outcome);
}

async function drain(settled: readonly SettledCodexStartupOutcome[]): Promise<void> {
  await Promise.allSettled(settled.map((entry) => entry.settled));
}

describe("Codex startup prompt retry on rejected write", () => {
  test("C-CODEX-17 a REJECTED update-skip write stays retryable and never resolves as answered", async () => {
    const responder = new CodexStartupPromptResponder("s1");
    const frame = "Update available\n  1. Update now\n  2. Continue without updating";
    // The write is rejected: the skip must NOT settle, and its `settled` promise
    // must reject (so the caller warns rather than reporting a false "answered"),
    // leaving the update prompt for a later frame to re-attempt.
    const rejecting = responder.handle(frame, () => Promise.reject(new Error("pty closed")));
    expect(outcomesOf(rejecting.outcomes)).toEqual([
      { kind: "answered", prompt: "update", input: "2" },
    ]);
    await expect(rejecting.outcomes[0]?.settled).rejects.toThrow("pty closed");
    // Retryable: the next frame re-attempts the skip with a fulfilling write.
    const writes: string[] = [];
    const retried = responder.handle(frame, (input) => {
      writes.push(input);
    });
    expect(outcomesOf(retried.outcomes)).toEqual([
      { kind: "answered", prompt: "update", input: "2" },
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
      { kind: "answered", prompt: "workspace_trust", input: "1" },
    ]);
    expect(writes).toEqual(["1\r"]);
    await drain(retried.outcomes);
  });
});
