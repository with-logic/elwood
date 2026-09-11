/**
 * Lifecycle Claude hook input validation coverage.
 * Covers PRD §6.4, C-HOOK-07, and C-HOOK-17.
 */

import { describe, expect, test } from "vitest";
import { isClaudeHookInput as isClaudeHookEvent } from "../../src/claude/validate/input.ts";
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
  test("C-HOOK-07 C-HOOK-17 validates lifecycle hook inputs by event-specific schema", () => {
    expect(isClaudeHookEvent(null)).toBe(false);
    expect(isClaudeHookEvent({ hook_event_name: "Stop", session_id: "x" })).toBe(false);
    expect(isClaudeHookEvent(base("Unknown", {}))).toBe(false);
    expect(isClaudeHookEvent(base("Stop", { stop_hook_active: false }))).toBe(true);
    expect(isClaudeHookEvent(base("Stop", { stop_hook_active: "no" }))).toBe(false);
    expect(isClaudeHookEvent(base("SessionStart", { source: "startup" }))).toBe(true);
    expect(isClaudeHookEvent(base("Setup", { trigger: "init" }))).toBe(true);
    expect(isClaudeHookEvent(base("Setup", { trigger: "manual" }))).toBe(false);
    expect(isClaudeHookEvent(base("InstructionsLoaded", instructions()))).toBe(true);
    expect(isClaudeHookEvent(base("UserPromptSubmit", { prompt: "hello" }))).toBe(true);
    expect(isClaudeHookEvent(base("UserPromptExpansion", expansion()))).toBe(true);
    expect(isClaudeHookEvent(base("PostToolBatch", { tool_calls: [] }))).toBe(true);
    expect(isClaudeHookEvent(base("PostToolBatch", { tool_calls: [batchToolCall()] }))).toBe(true);
    expect(
      isClaudeHookEvent(base("Notification", { message: "msg", notification_type: "info" })),
    ).toBe(true);
    expect(isClaudeHookEvent(base("SubagentStart", subagent()))).toBe(true);
    expect(isClaudeHookEvent(base("SubagentStop", subagent({ transcript: "/tmp/a" })))).toBe(true);
    expect(isClaudeHookEvent(base("TaskCreated", task()))).toBe(true);
    expect(isClaudeHookEvent(base("TaskCompleted", task()))).toBe(true);
    expect(isClaudeHookEvent(base("StopFailure", { error: "rate_limit" }))).toBe(true);
    expect(isClaudeHookEvent(base("TeammateIdle", { teammate_name: "a", team_name: "t" }))).toBe(
      true,
    );
    expect(isClaudeHookEvent(base("ConfigChange", { source: "local" }))).toBe(true);
    expect(isClaudeHookEvent(base("CwdChanged", { old_cwd: "/a", new_cwd: "/b" }))).toBe(true);
    expect(isClaudeHookEvent(base("FileChanged", { file_path: "/a", event: "change" }))).toBe(true);
    expect(isClaudeHookEvent(base("FileChanged", { file_path: "/a", event: "rename" }))).toBe(
      false,
    );
    expect(isClaudeHookEvent(base("WorktreeCreate", { name: "feature" }))).toBe(true);
    expect(isClaudeHookEvent(base("WorktreeRemove", { worktree_path: "/tmp/w" }))).toBe(true);
    expect(
      isClaudeHookEvent(base("PreCompact", { trigger: "manual", custom_instructions: "" })),
    ).toBe(true);
    // Real manual /compact sends custom_instructions: null (captured 2026-07).
    expect(
      isClaudeHookEvent(base("PreCompact", { trigger: "manual", custom_instructions: null })),
    ).toBe(true);
    expect(isClaudeHookEvent(base("PreCompact", { trigger: "manual" }))).toBe(true);
    expect(
      isClaudeHookEvent(base("PreCompact", { trigger: "manual", custom_instructions: 7 })),
    ).toBe(false);
    expect(isClaudeHookEvent(base("PostCompact", compact()))).toBe(true);
    expect(isClaudeHookEvent(base("SessionEnd", { reason: "exit" }))).toBe(true);
    expect(isClaudeHookEvent(base("Elicitation", { mcp_server_name: "s", message: "m" }))).toBe(
      true,
    );
    expect(
      isClaudeHookEvent(base("ElicitationResult", { mcp_server_name: "s", action: "a" })),
    ).toBe(true);
  });
});
