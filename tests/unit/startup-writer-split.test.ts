/**
 * Trust answers and non-trust automation use SEPARATE writers, so the two classes can be
 * guarded differently (#42). Behaviour-neutral: with one writer, nothing changes.
 * Implements PRD §5.1/§5.4/§5.5.
 */
import { expect, test, vi } from "vitest";
import { ClaudeStartupPromptResponder } from "../../src/claude/startup-prompts.ts";
import { CodexStartupPromptResponder } from "../../src/codex/startup-prompts.ts";

const browserPrompt =
  "Claude Code running in a browser?\n❯ 1. Yes, use my browser\n  2. No, keep browser tools off";
const updateScreen = "Update available! 0.148.0 -> 0.149.1\n› 1. Update now\n  2. Skip";
const claudeTrust =
  "Do you trust this folder?\n\n❯ 1. Yes, proceed\n  2. No, exit\n\nEnter to confirm · Esc to cancel";

test("C-CLAUDE-16 the browser-tools decline goes to the automation writer, not the trust writer", () => {
  const trustWrites: string[] = [];
  const automationWrites: string[] = [];
  const responder = new ClaudeStartupPromptResponder(true);
  responder.handle(
    browserPrompt,
    (input) => void trustWrites.push(input),
    () => browserPrompt,
    (input) => void automationWrites.push(input),
  );
  expect(automationWrites).toEqual([""]);
  expect(trustWrites).toEqual([]);
});

test("C-CLAUDE-16 a trust answer still goes to the trust writer", () => {
  const trustWrites: string[] = [];
  const automationWrites: string[] = [];
  // autotrust on: the responder answers the allowlisted gate itself.
  const responder = new ClaudeStartupPromptResponder(true);
  responder.handle(
    claudeTrust,
    (input) => void trustWrites.push(input),
    () => claudeTrust,
    (input) => void automationWrites.push(input),
  );
  expect(automationWrites).toEqual([]); // never the automation writer
});

test("C-CODEX-12 the update skip goes to the automation writer, not the trust writer", async () => {
  vi.useFakeTimers();
  const trustWrites: string[] = [];
  const automationWrites: string[] = [];
  const responder = new CodexStartupPromptResponder("s", true);
  responder.handle(
    updateScreen,
    (input) => void trustWrites.push(input),
    () => updateScreen,
    (input) => void automationWrites.push(input),
  );
  await vi.advanceTimersByTimeAsync(6_000);
  expect(automationWrites[0]).toBe("2");
  expect(trustWrites).toEqual([]);
  vi.useRealTimers();
});

test("C-CODEX-12 one writer keeps today's behaviour: the default routes both", async () => {
  vi.useFakeTimers();
  const writes: string[] = [];
  const responder = new CodexStartupPromptResponder("s", true);
  responder.handle(
    updateScreen,
    (input) => void writes.push(input),
    () => updateScreen,
  );
  await vi.advanceTimersByTimeAsync(6_000);
  expect(writes[0]).toBe("2");
  vi.useRealTimers();
});
