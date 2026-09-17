/** Valid optional event fields for ingress contract tests (PRD §6.4). */

import { expansion, instructions, subagent, task } from "./claude-validate-input-helpers.ts";

const stop = {
  stop_hook_active: false,
  last_assistant_message: "done",
  background_tasks: [
    {
      id: "task",
      type: "agent",
      status: "running",
      description: "work",
      command: "ls",
      agent_type: "agent",
      server: "mcp",
      tool: "tool",
      name: "name",
    },
  ],
  session_crons: [{ id: "cron", schedule: "* * * * *", recurring: true, prompt: "work" }],
};
const tool = { tool_name: "Bash", tool_input: { command: "echo ok" } };

export const eventFieldCases: readonly [
  string,
  Record<string, unknown>,
  Record<string, unknown>,
][] = [
  ["SessionStart", { source: "startup" }, { model: "model", agent_type: "agent" }],
  [
    "InstructionsLoaded",
    instructions(),
    { globs: ["*.ts"], trigger_file_path: "a.ts", parent_file_path: "b.ts" },
  ],
  ["UserPromptExpansion", expansion(), { command_args: "args", command_source: "project" }],
  ["PreToolUse", tool, { tool_use_id: "tool" }],
  [
    "PermissionRequest",
    tool,
    { permission_suggestions: [{ type: "setMode", mode: "plan", destination: "session" }] },
  ],
  ["PostToolUse", { ...tool, tool_response: "done" }, { tool_use_id: "tool", duration_ms: 10 }],
  [
    "PostToolUseFailure",
    { ...tool, error: "failed" },
    { tool_use_id: "tool", duration_ms: 10, is_interrupt: false },
  ],
  ["Notification", { message: "hello", notification_type: "info" }, { title: "notice" }],
  ["SubagentStop", subagent({ transcript: "/tmp/a" }), stop],
  ["Stop", {}, stop],
  ["TaskCreated", task(), { task_description: "work", teammate_name: "agent", team_name: "team" }],
  [
    "TaskCompleted",
    task(),
    { task_description: "work", teammate_name: "agent", team_name: "team" },
  ],
  [
    "StopFailure",
    { error: "unknown" },
    { error_details: "details", last_assistant_message: "done" },
  ],
  ["ConfigChange", { source: "project" }, { file_path: "config.json" }],
  [
    "Elicitation",
    { mcp_server_name: "server", message: "question" },
    { mode: "form", url: "https://example.test", elicitation_id: "1", requested_schema: {} },
  ],
  [
    "ElicitationResult",
    { mcp_server_name: "server", action: "accept" },
    { mode: "form", elicitation_id: "1", content: {} },
  ],
];

export const taskFields = stop.background_tasks[0]!;
export const cronFields = stop.session_crons[0]!;
