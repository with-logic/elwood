/**
 * Unit tests for Claude startup prompt automation.
 * Covers C-CLAUDE-10 and C-CLAUDE-11.
 */

import { describe, expect, test } from "vitest";
import {
  browserToolsPromptVisible,
  ClaudeStartupPromptResponder,
} from "../../src/claude/startup-prompts.ts";

// Captured from a real claude session that wedged an embedded start.
const browserPrompt = [
  "  ❯ 1. Yes, use my browser",
  "    2. No, keep browser tools off",
  "  Enter to confirm · Esc to keep browser tools off",
].join("\n");

describe("ClaudeStartupPromptResponder", () => {
  test("C-CLAUDE-11 declines the browser tools prompt once via Escape", () => {
    const responder = new ClaudeStartupPromptResponder(false);
    const writes: string[] = [];
    const first = responder.handle(browserPrompt, (input) => writes.push(input));
    expect(first).toEqual([{ prompt: "browser_tools", input: "esc" }]);
    expect(writes).toEqual(["\u001b"]);
    expect(responder.handle(browserPrompt, (input) => writes.push(input))).toEqual([]);
    expect(writes).toEqual(["\u001b"]);
  });

  test("C-CLAUDE-10 workspace trust and browser prompts automate in a single frame", () => {
    const responder = new ClaudeStartupPromptResponder(true);
    const writes: string[] = [];
    const combined = `Do you trust this folder?\n ❯ 1. Yes, continue\n${browserPrompt}`;
    const automations = responder.handle(combined, (input) => writes.push(input));
    expect(automations.map((automation) => automation.prompt)).toEqual([
      "workspace_trust",
      "browser_tools",
    ]);
    expect(writes).toEqual(["1\r", "\u001b"]);
  });

  test("C-CLAUDE-11 detection requires both prompt phrases", () => {
    expect(browserToolsPromptVisible("2. No, keep browser tools off")).toBe(false);
    expect(browserToolsPromptVisible("1. Yes, use my browser")).toBe(false);
    expect(browserToolsPromptVisible(browserPrompt)).toBe(true);
  });
});
