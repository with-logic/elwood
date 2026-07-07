/**
 * Unit tests for rendered-TUI turn-state watching.
 * Covers PRD §5.3, C-TURN-01, C-TURN-02, and C-TURN-03.
 */

import { describe, expect, test } from "vitest";
import { claudeComposerVisible } from "../../src/claude/startup-prompts.ts";
import { codexComposerVisible } from "../../src/codex/initial-ready.ts";
import {
  claudeInterruptBanner,
  codexInterruptBanner,
  TurnStateWatcher,
  turnRunningToken,
} from "../../src/core/turn-state.ts";

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
    const watcher = new TurnStateWatcher(claudeComposerVisible, claudeInterruptBanner);
    watcher.arm();
    expect(watcher.observe(claudeIdle)).toBeUndefined();
    expect(watcher.observe(claudeWorking)).toBe("started");
    expect(watcher.observe(claudeWorking)).toBeUndefined();
    expect(watcher.observe(claudeIdle)).toBe("ended");
    expect(watcher.observe(claudeIdle)).toBeUndefined();
  });

  test("C-TURN-02 an interrupt end needs no hook, only the rendered screen", () => {
    const watcher = new TurnStateWatcher(codexComposerVisible, codexInterruptBanner);
    watcher.arm();
    expect(watcher.observe(codexWorking)).toBe("started");
    expect(watcher.observe(codexInterrupted)).toBe("ended");
  });

  test("C-TURN-03 unarmed watching reports nothing (startup spinners)", () => {
    const watcher = new TurnStateWatcher(codexComposerVisible, codexInterruptBanner);
    expect(watcher.observe(codexWorking)).toBeUndefined();
    expect(watcher.observe(codexIdle)).toBeUndefined();
  });

  test("C-TURN-03 a screen with neither indicator holds the running state", () => {
    const watcher = new TurnStateWatcher(claudeComposerVisible, claudeInterruptBanner);
    watcher.arm();
    expect(watcher.observe(claudeWorking)).toBe("started");
    expect(watcher.observe(modalDialog)).toBeUndefined();
    expect(watcher.observe(claudeIdle)).toBe("ended");
  });
});

// Banner lines captured from real interrupted sessions at 46 and 100 cols.
const claudeBanner46 = "  ⎿  Interrupted· What should Claude do \n❯ ";
const claudeBanner100 = "  ⎿  Interrupted · What should Claude do instead?\n❯ ";
const narrowClaudeWorking = "  essay text streaming, footer elided\n❯ ";

describe("C-TURN-04 interrupt end banners", () => {
  test("banner fires ended at narrow widths where working was never seen", () => {
    const watcher = new TurnStateWatcher(claudeComposerVisible, claudeInterruptBanner);
    watcher.arm();
    expect(watcher.observe(narrowClaudeWorking)).toBeUndefined();
    expect(watcher.observe(claudeBanner46)).toBe("ended");
    // The banner persists on screen; the edge fires exactly once.
    expect(watcher.observe(claudeBanner46)).toBeUndefined();
  });

  test("banner works at wide sizes and re-arms after clearing", () => {
    const watcher = new TurnStateWatcher(claudeComposerVisible, claudeInterruptBanner);
    watcher.arm();
    expect(watcher.observe(claudeWorking)).toBe("started");
    expect(watcher.observe(claudeBanner100)).toBe("ended");
    expect(watcher.observe(claudeWorking)).toBe("started");
    expect(watcher.observe(claudeBanner100)).toBe("ended");
  });

  test("codex banner matches without colliding with the working token", () => {
    expect(codexInterruptBanner.test("■ Conversation interrupted - tell the model")).toBe(true);
    expect(codexInterruptBanner.test("• Working (3s • esc to interrupt)")).toBe(false);
    expect(claudeInterruptBanner.test("the essay was Interrupted by rain")).toBe(false);
  });
});
