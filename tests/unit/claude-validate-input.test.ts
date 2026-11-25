/**
 * Lifecycle Claude hook input validation coverage.
 * Covers PRD §6.4, C-HOOK-07, and C-HOOK-17.
 */

import { describe, expect, test } from "vitest";
import { claudeAcceptanceSignal } from "../../src/claude/accepted-turn.ts";
import { normalizeClaudeHookEvent } from "../../src/claude/normalize.ts";
import { isClaudeHookInput } from "../../src/claude/validate/input.ts";
import { defaultAcceptanceSignal } from "../../src/core/simple/acceptance-signal.ts";
import {
  base,
  batchToolCall,
  compact,
  expansion,
  instructions,
  subagent,
  task,
} from "./claude-validate-input-helpers.ts";

describe("Claude hook input validation (lifecycle)", () => {
  test.each([
    { name: "omitted", fields: {}, accepted: false },
    { name: "null", fields: { prompt: null }, accepted: false },
    { name: "empty", fields: { prompt: "" }, accepted: true },
  ])("C-API-62 distinguishes an $name native prompt", ({ fields, accepted }) => {
    const wire = base("UserPromptSubmit", fields);
    expect(isClaudeHookInput(wire)).toBe(true);
    const event = normalizeClaudeHookEvent(wire);
    if (event.hook_event_name !== "UserPromptSubmit") throw new Error("Expected a submit hook");
    expect(event).toMatchObject({ prompt: "" });
    expect(defaultAcceptanceSignal(event, "")).toBe(accepted);
    expect(claudeAcceptanceSignal(event, "")).toBe(accepted);
  });
  test("C-HOOK-07 C-HOOK-17 validates lifecycle hook inputs by event-specific schema", () => {
    expect(isClaudeHookInput(null)).toBe(false);
    expect(isClaudeHookInput({ hook_event_name: "Stop", session_id: "x" })).toBe(false);
    expect(isClaudeHookInput(base("Unknown", {}))).toBe(false);
    expect(isClaudeHookInput(base("Stop", { stop_hook_active: false }))).toBe(true);
    expect(isClaudeHookInput(base("Stop", { stop_hook_active: "no" }))).toBe(false);
    expect(isClaudeHookInput(base("SessionStart", { source: "startup" }))).toBe(true);
    expect(isClaudeHookInput(base("Setup", { trigger: "init" }))).toBe(true);
    expect(isClaudeHookInput(base("Setup", { trigger: "manual" }))).toBe(false);
    expect(isClaudeHookInput(base("InstructionsLoaded", instructions()))).toBe(true);
    expect(isClaudeHookInput(base("UserPromptSubmit", { prompt: "hello" }))).toBe(true);
    expect(isClaudeHookInput(base("UserPromptSubmit", { prompt: false }))).toBe(false);
    expect(isClaudeHookInput(base("UserPromptExpansion", expansion()))).toBe(true);
    expect(isClaudeHookInput(base("PostToolBatch", { tool_calls: [] }))).toBe(true);
    expect(isClaudeHookInput(base("PostToolBatch", { tool_calls: [batchToolCall()] }))).toBe(true);
    expect(
      isClaudeHookInput(base("Notification", { message: "msg", notification_type: "info" })),
    ).toBe(true);
    expect(isClaudeHookInput(base("SubagentStart", subagent()))).toBe(true);
    expect(isClaudeHookInput(base("SubagentStop", subagent({ transcript: "/tmp/a" })))).toBe(true);
    expect(isClaudeHookInput(base("TaskCreated", task()))).toBe(true);
    expect(isClaudeHookInput(base("TaskCompleted", task()))).toBe(true);
    expect(isClaudeHookInput(base("StopFailure", { error: "rate_limit" }))).toBe(true);
    expect(isClaudeHookInput(base("TeammateIdle", { teammate_name: "a", team_name: "t" }))).toBe(
      true,
    );
    expect(isClaudeHookInput(base("ConfigChange", { source: "local" }))).toBe(true);
    expect(isClaudeHookInput(base("CwdChanged", { old_cwd: "/a", new_cwd: "/b" }))).toBe(true);
    expect(isClaudeHookInput(base("FileChanged", { file_path: "/a", event: "change" }))).toBe(true);
    expect(isClaudeHookInput(base("FileChanged", { file_path: "/a", event: "rename" }))).toBe(
      false,
    );
    expect(isClaudeHookInput(base("WorktreeCreate", { name: "feature" }))).toBe(true);
    expect(isClaudeHookInput(base("WorktreeRemove", { worktree_path: "/tmp/w" }))).toBe(true);
    expect(
      isClaudeHookInput(base("PreCompact", { trigger: "manual", custom_instructions: "" })),
    ).toBe(true);
    // Real manual /compact sends custom_instructions: null (captured 2026-07).
    expect(
      isClaudeHookInput(base("PreCompact", { trigger: "manual", custom_instructions: null })),
    ).toBe(true);
    expect(isClaudeHookInput(base("PreCompact", { trigger: "manual" }))).toBe(true);
    expect(
      isClaudeHookInput(base("PreCompact", { trigger: "manual", custom_instructions: 7 })),
    ).toBe(false);
    expect(isClaudeHookInput(base("PostCompact", compact()))).toBe(true);
    expect(isClaudeHookInput(base("SessionEnd", { reason: "exit" }))).toBe(true);
    expect(isClaudeHookInput(base("Elicitation", { mcp_server_name: "s", message: "m" }))).toBe(
      true,
    );
    expect(
      isClaudeHookInput(base("ElicitationResult", { mcp_server_name: "s", action: "a" })),
    ).toBe(true);
  });
});
