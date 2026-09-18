/**
 * Unit tests for Claude startup prompt automation.
 * Covers C-CLAUDE-10, C-CLAUDE-11, and C-CLAUDE-16.
 */

import { describe, expect, test } from "vitest";
import {
  browserToolsPromptVisible,
  ClaudeStartupPromptResponder,
} from "../../src/claude/startup-prompts.ts";
import type { SettledStartupOutcome } from "../../src/core/startup/write.ts";
import { claudeTrust } from "../fixtures/trust-composer.ts";

// Captured from a real claude session that wedged an embedded start.
const browserPrompt = [
  "  ❯ 1. Yes, use my browser",
  "    2. No, keep browser tools off",
  "  Enter to confirm · Esc to keep browser tools off",
].join("\n");

const esc = String.fromCharCode(0x1b);

/** The bare outcomes of a settled-outcome list, for concise assertions. */
function outcomesOf(settled: readonly SettledStartupOutcome<"claude">[]) {
  return settled.map((entry) => entry.outcome);
}

/** Await every write completion (rejections included) so post-settle state is observable. */
async function drain(settled: readonly SettledStartupOutcome<"claude">[]): Promise<void> {
  await Promise.allSettled(settled.map((entry) => entry.settled));
}

describe("ClaudeStartupPromptResponder", () => {
  test("C-CLAUDE-11 declines the browser tools prompt once via Escape", async () => {
    const responder = new ClaudeStartupPromptResponder(false);
    const writes: string[] = [];
    const first = responder.handle(browserPrompt, (input) => {
      writes.push(input);
    });
    expect(outcomesOf(first)).toEqual([
      { kind: "attempted", prompt: "browser_tools", input: "esc" },
    ]);
    expect(writes).toEqual([esc]);
    await drain(first);
    expect(
      responder.handle(browserPrompt, (input) => {
        writes.push(input);
      }),
    ).toEqual([]);
    expect(writes).toEqual([esc]);
  });

  test("C-TRUST-01 a browser prompt below an old trust dialog gets no approval and no blind decline", () => {
    const responder = new ClaudeStartupPromptResponder(true);
    const writes: string[] = [];
    const combined = `${claudeTrust}\n ❯ 1. Yes, continue\n${browserPrompt}`;
    const settled = responder.handle(combined, (input) => {
      writes.push(input);
    });
    // A trust candidate on screen holds the frame: neither an approval nor a blind decline.
    expect(outcomesOf(settled)).toEqual([]);
    expect(writes).toEqual([]);
  });

  test("C-CLAUDE-11 detection requires both prompt phrases", () => {
    expect(browserToolsPromptVisible("2. No, keep browser tools off")).toBe(false);
    expect(browserToolsPromptVisible("1. Yes, use my browser")).toBe(false);
    expect(browserToolsPromptVisible(browserPrompt)).toBe(true);
  });

  test("C-CLAUDE-14 a recognized trust prompt whose affirmative has not rendered is option_pending, not answered", () => {
    const responder = new ClaudeStartupPromptResponder(true);
    const writes: string[] = [];
    // MCP prompt recognized, but the affirmative option ("Use this MCP server")
    // has not rendered yet, so it is surfaced as a transient option_pending and
    // not answered — a later frame carrying the option would still answer it.
    const settled = responder.handle(
      "New MCP server found in this project\n2. Continue without using this MCP server",
      (input) => {
        writes.push(input);
      },
    );
    expect(settled).toEqual([{ outcome: { kind: "option_pending", prompt: "mcp_trust" } }]);
    expect(writes).toEqual([]);
  });

  test("C-CLAUDE-16 a REJECTED browser-tools write stays retryable and never resolves as answered", async () => {
    const responder = new ClaudeStartupPromptResponder(true);
    let attempts = 0;
    // The PTY write is rejected on the first frame: the decline must NOT settle,
    // and its `settled` promise must reject (so the caller warns instead of
    // emitting a false "answered"), leaving the prompt for a later frame.
    const rejecting = responder.handle(browserPrompt, () => {
      attempts += 1;
      return Promise.reject(new Error("pty closed"));
    });
    expect(outcomesOf(rejecting)).toEqual([
      { kind: "attempted", prompt: "browser_tools", input: "esc" },
    ]);
    await expect(rejecting[0]?.settled).rejects.toThrow("pty closed");
    // Retryable: a later frame re-attempts the decline (write count grows to 2).
    const retried = responder.handle(browserPrompt, () => undefined);
    expect(outcomesOf(retried)).toEqual([
      { kind: "attempted", prompt: "browser_tools", input: "esc" },
    ]);
    await drain(retried);
    expect(attempts).toBe(1);
  });

  test("C-CLAUDE-16 a REJECTED trust write leaves the trust prompt retryable", async () => {
    const responder = new ClaudeStartupPromptResponder(true);
    const frame = `${claudeTrust}\n ❯ 1. Yes, continue`;
    const rejecting = responder.handle(frame, () => Promise.reject(new Error("pty closed")));
    await expect(rejecting[0]?.settled).rejects.toThrow("pty closed");
    // Not settled: a later frame answers it, this time with a fulfilling write.
    const writes: string[] = [];
    const retried = responder.handle(frame, (input) => {
      writes.push(input);
    });
    expect(outcomesOf(retried)).toEqual([
      { kind: "attempted", prompt: "workspace_trust", input: "1" },
    ]);
    expect(writes).toEqual(["1\r"]);
    await drain(retried);
  });
});
