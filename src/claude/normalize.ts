/**
 * Normalizes Claude hook payloads before public dispatch.
 * Implements PRD §6.4 future-tool compatibility.
 */

import type { ClaudeHookEvent } from "./hooks.ts";

const knownToolNames = new Set([
  "Agent",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Glob",
  "Grep",
  "LS",
  "ListMcpResourcesTool",
  "LSP",
  "Monitor",
  "MultiEdit",
  "NotebookEdit",
  "PowerShell",
  "PushNotification",
  "Read",
  "ReadMcpResourceTool",
  "RemoteTrigger",
  "ScheduleWakeup",
  "SendMessage",
  "ShareOnboardingGuide",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TeamCreate",
  "TeamDelete",
  "TodoWrite",
  "ToolSearch",
  "WaitForMcpServers",
  "WebFetch",
  "WebSearch",
  "Write",
]);

export function normalizeClaudeHookEvent(input: unknown): ClaudeHookEvent {
  const event = input as ClaudeHookEvent;
  if (!("tool_name" in event) || typeof event.tool_name !== "string") return event;
  if (isPublicToolName(event.tool_name)) return event;
  return { ...event, tool_name: `unknown:${event.tool_name}` } as ClaudeHookEvent;
}

function isPublicToolName(value: string): boolean {
  return knownToolNames.has(value) || value.startsWith("mcp__") || value.startsWith("unknown:");
}
