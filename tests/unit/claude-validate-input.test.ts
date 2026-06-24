/**
 * Event-specific Claude hook input validation coverage.
 * Covers PRD §6.4.
 */

import { describe, expect, test } from "vitest";
import { isClaudeHookInput as isClaudeHookEvent } from "../../src/claude/validate-input.ts";

describe("Claude hook input validation", () => {
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
    expect(isClaudeHookEvent(base("PostCompact", compact()))).toBe(true);
    expect(isClaudeHookEvent(base("SessionEnd", { reason: "exit" }))).toBe(true);
    expect(isClaudeHookEvent(base("Elicitation", { mcp_server_name: "s", message: "m" }))).toBe(
      true,
    );
    expect(
      isClaudeHookEvent(base("ElicitationResult", { mcp_server_name: "s", action: "a" })),
    ).toBe(true);
  });

  test("C-HOOK-07 C-HOOK-17 validates tool hook inputs by known tool schema", () => {
    expect(isClaudeHookEvent(tool("Agent", { prompt: "do it" }))).toBe(true);
    expect(isClaudeHookEvent(tool("AskUserQuestion", { questions: [] }))).toBe(true);
    expect(
      isClaudeHookEvent(
        tool("AskUserQuestion", {
          questions: [{ question: "Q?", header: "Choice", options: [{ label: "A" }] }],
        }),
      ),
    ).toBe(true);
    expect(isClaudeHookEvent(tool("AskUserQuestion", { questions: [{ question: "Q?" }] }))).toBe(
      false,
    );
    expect(isClaudeHookEvent(tool("Bash", { command: "echo ok" }))).toBe(true);
    expect(
      isClaudeHookEvent(tool("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" })),
    ).toBe(true);
    expect(isClaudeHookEvent(tool("ExitPlanMode", {}))).toBe(true);
    expect(isClaudeHookEvent(tool("Glob", { pattern: "*.ts" }))).toBe(true);
    expect(isClaudeHookEvent(tool("Grep", { pattern: "foo" }))).toBe(true);
    expect(isClaudeHookEvent(tool("Read", { file_path: "a.ts" }))).toBe(true);
    expect(isClaudeHookEvent(tool("WebFetch", { url: "https://e.test", prompt: "read" }))).toBe(
      true,
    );
    expect(isClaudeHookEvent(tool("WebSearch", { query: "docs" }))).toBe(true);
    expect(isClaudeHookEvent(tool("Write", { file_path: "a.ts", content: "x" }))).toBe(true);
    expect(isClaudeHookEvent(tool("mcp__server__tool", { raw: true }))).toBe(true);
    expect(isClaudeHookEvent(tool("Bash", {}))).toBe(false);
    expect(isClaudeHookEvent(tool("Bash", { command: "echo ok" }, "PostToolUse"))).toBe(false);
    expect(isClaudeHookEvent(tool("Bash", { command: "echo ok" }, "PostToolUse", response()))).toBe(
      true,
    );
    expect(
      isClaudeHookEvent(
        base("PostToolBatch", {
          tool_calls: [{ tool_name: "Bash", tool_input: { command: "echo ok" } }],
        }),
      ),
    ).toBe(false);
    expect(
      isClaudeHookEvent(
        tool("Bash", { command: "echo ok" }, "PostToolUseFailure", { error: "failed" }),
      ),
    ).toBe(true);
    expect(
      isClaudeHookEvent(tool("Bash", { command: "echo ok" }, "PermissionDenied", { reason: "no" })),
    ).toBe(false);
    expect(
      isClaudeHookEvent(tool("Bash", { command: "echo ok" }, "PermissionDenied", denied())),
    ).toBe(true);
  });
});

function base(hook_event_name: string, fields: Record<string, unknown>) {
  return { hook_event_name, session_id: "claude-1", cwd: "/tmp/project", ...fields };
}

function subagent(options: { readonly transcript?: string } = {}) {
  return {
    agent_id: "agent-1",
    agent_type: "general-purpose",
    ...(options.transcript === undefined ? {} : { agent_transcript_path: options.transcript }),
  };
}

function task() {
  return { task_id: "task-1", task_subject: "work" };
}

function compact() {
  return { trigger: "manual", compact_summary: "sum" };
}

function expansion() {
  return { expansion_type: "slash_command", command_name: "test", prompt: "/test" };
}

function instructions() {
  return {
    file_path: "/tmp/CLAUDE.md",
    memory_type: "Project",
    load_reason: "session_start",
  };
}

function response() {
  return { tool_response: "ok" };
}

function denied() {
  return { tool_use_id: "tool-1", reason: "no" };
}

function batchToolCall() {
  return { tool_name: "Bash", tool_input: { command: "echo ok" }, tool_response: "ok" };
}

function tool(
  tool_name: string,
  tool_input: Record<string, unknown>,
  hook_event_name = "PreToolUse",
  fields: Record<string, unknown> = {},
) {
  return base(hook_event_name, { tool_name, tool_input, ...fields });
}
