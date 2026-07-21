/**
 * Shared event/tool builders for Claude hook input validation tests.
 * Supports PRD §6.4, C-HOOK-07, and C-HOOK-17 coverage.
 */

export function base(hook_event_name: string, fields: Record<string, unknown>) {
  return { hook_event_name, session_id: "claude-1", cwd: "/tmp/project", ...fields };
}

export function subagent(options: { readonly transcript?: string } = {}) {
  return {
    agent_id: "agent-1",
    agent_type: "general-purpose",
    ...(options.transcript === undefined ? {} : { agent_transcript_path: options.transcript }),
  };
}

export function task() {
  return { task_id: "task-1", task_subject: "work" };
}

export function compact() {
  return { trigger: "manual", compact_summary: "sum" };
}

export function expansion() {
  return { expansion_type: "slash_command", command_name: "test", prompt: "/test" };
}

export function instructions() {
  return {
    file_path: "/tmp/CLAUDE.md",
    memory_type: "Project",
    load_reason: "session_start",
  };
}

export function response() {
  return { tool_response: "ok" };
}

export function denied() {
  return { tool_use_id: "tool-1", reason: "no" };
}

export function batchToolCall() {
  return { tool_name: "Bash", tool_input: { command: "echo ok" }, tool_response: "ok" };
}

export function tool(
  tool_name: string,
  tool_input: Record<string, unknown>,
  hook_event_name = "PreToolUse",
  fields: Record<string, unknown> = {},
) {
  return base(hook_event_name, { tool_name, tool_input, ...fields });
}
