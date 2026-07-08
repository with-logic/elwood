/**
 * Unit tests for rendered-screen attention (blocked) watching.
 * Covers PRD §5.3 and C-ATTN-01 through C-ATTN-03.
 */

import { describe, expect, test } from "vitest";
import {
  claudeScreenFactTable,
  claudeScreenFactTableForTrustPolicy,
} from "../../src/claude/screen-table.ts";
import { codexScreenFactTableForTrustPolicy } from "../../src/codex/screen-table.ts";
import { AttentionWatcher, activityFromAttention } from "../../src/core/attention.ts";
import { readScreenFacts, type ScreenFactTable } from "../../src/core/screen-facts.ts";

/** Classifies a screen the way observeRenderedFrame does before the watcher. */
const read = (table: ScreenFactTable, text: string) => readScreenFacts(table, { text, title: "" });

const claudePermission =
  "Do you want to create elwood.txt?\n ❯ 1. Yes\n   2. Yes, allow all\n   3. No\n Esc to cancel";
const claudeIdle = "❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)";
const claudeTrust = "Do you trust this folder?\n❯ 1. Yes, proceed\n  2. No, exit";
const codexApproval =
  "Would you like to run the following command?\n $ rm -rf build\n › 1. Yes, proceed (y)\n   3. No (esc)\n Press enter to confirm or esc to cancel";
const codexIdle = "› Explain this codebase\n  gpt-5.5 high";

describe("AttentionWatcher", () => {
  test("C-ATTN-01 raises on a Claude permission dialog with matched rule ids", () => {
    const watcher = new AttentionWatcher();
    const raised = watcher.observe(read(claudeScreenFactTable, claudePermission));
    expect(raised).toEqual({ edge: "raised", ruleIds: ["claude-permission-dialog"] });
    // Idempotent while the dialog persists.
    expect(watcher.observe(read(claudeScreenFactTable, claudePermission))).toBeUndefined();
  });

  test("C-ATTN-02 clears when the dialog resolves", () => {
    const watcher = new AttentionWatcher();
    watcher.observe(read(claudeScreenFactTable, claudePermission));
    expect(watcher.observe(read(claudeScreenFactTable, claudeIdle))).toEqual({
      edge: "cleared",
      ruleIds: [],
    });
    expect(watcher.observe(read(claudeScreenFactTable, claudeIdle))).toBeUndefined();
  });

  test("C-ATTN-01 raises on a Codex approval dialog", () => {
    const table = codexScreenFactTableForTrustPolicy(true);
    const watcher = new AttentionWatcher();
    expect(watcher.observe(read(table, codexApproval))).toEqual({
      edge: "raised",
      ruleIds: ["codex-approval-dialog"],
    });
    expect(watcher.observe(read(table, codexIdle))).toEqual({ edge: "cleared", ruleIds: [] });
  });

  test("C-ATTN-03 an unanswered trust prompt blocks only when autotrust is off", () => {
    expect(
      new AttentionWatcher().observe(read(claudeScreenFactTableForTrustPolicy(false), claudeTrust)),
    ).toEqual({
      edge: "raised",
      ruleIds: ["claude-trust-prompt"],
    });
    expect(
      new AttentionWatcher().observe(read(claudeScreenFactTableForTrustPolicy(true), claudeTrust)),
    ).toBeUndefined();
  });
});

describe("activityFromAttention", () => {
  test("labels the event with the matched rule ids", () => {
    const event = activityFromAttention("claude", "elwood-1", ["claude-permission-dialog"]);
    expect(event).toMatchObject({
      agent: "claude",
      source: "terminal",
      kind: "attention",
      label: "claude-permission-dialog",
    });
    expect(event.text).toContain("blocked");
  });
});
