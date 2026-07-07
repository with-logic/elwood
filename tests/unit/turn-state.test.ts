/**
 * Unit tests for rendered-TUI turn-state watching.
 * Covers PRD §5.3, C-TURN-01, C-TURN-02, and C-TURN-03.
 */

import { describe, expect, test } from "vitest";
import { claudeComposerVisible } from "../../src/claude/startup-prompts.ts";
import { codexComposerVisible } from "../../src/codex/initial-ready.ts";
import { TurnStateWatcher, turnRunningToken } from "../../src/core/turn-state.ts";

// Footers captured from real sessions (claude 2.1.201, codex-cli 0.142.5).
const claudeIdle = "❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents";
const claudeWorking =
  "❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents";
const codexIdle = "› Explain this codebase\n  gpt-5.5 high";
const codexWorking = "• Working (3s • esc to interrupt)\n› Explain this codebase";
const codexInterrupted = "■ Conversation interrupted - tell the model what to do.\n› ";
const modalDialog = "Allow this tool?\n  1. Yes\n  2. No";

describe("turn state watching", () => {
  test("C-TURN-03 the working token matches both captured footers", () => {
    expect(turnRunningToken.test(claudeWorking)).toBe(true);
    expect(turnRunningToken.test(codexWorking)).toBe(true);
    expect(turnRunningToken.test(claudeIdle)).toBe(false);
    expect(turnRunningToken.test(codexInterrupted)).toBe(false);
  });

  test("C-TURN-01 edges fire on start and on any turn end", () => {
    const watcher = new TurnStateWatcher(claudeComposerVisible);
    watcher.arm();
    expect(watcher.observe(claudeIdle)).toBeUndefined();
    expect(watcher.observe(claudeWorking)).toBe("started");
    expect(watcher.observe(claudeWorking)).toBeUndefined();
    expect(watcher.observe(claudeIdle)).toBe("ended");
    expect(watcher.observe(claudeIdle)).toBeUndefined();
  });

  test("C-TURN-02 an interrupt end needs no hook, only the rendered screen", () => {
    const watcher = new TurnStateWatcher(codexComposerVisible);
    watcher.arm();
    expect(watcher.observe(codexWorking)).toBe("started");
    expect(watcher.observe(codexInterrupted)).toBe("ended");
  });

  test("C-TURN-03 unarmed watching reports nothing (startup spinners)", () => {
    const watcher = new TurnStateWatcher(codexComposerVisible);
    expect(watcher.observe(codexWorking)).toBeUndefined();
    expect(watcher.observe(codexIdle)).toBeUndefined();
  });

  test("C-TURN-03 a screen with neither indicator holds the running state", () => {
    const watcher = new TurnStateWatcher(claudeComposerVisible);
    watcher.arm();
    expect(watcher.observe(claudeWorking)).toBe("started");
    expect(watcher.observe(modalDialog)).toBeUndefined();
    expect(watcher.observe(claudeIdle)).toBe("ended");
  });
});
