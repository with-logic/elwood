/**
 * Normalizes Claude hook payloads before public dispatch.
 * Implements PRD §6.4 future-tool compatibility.
 */

import type { ClaudeHookEvent } from "./hooks/index.ts";
import type { KnownClaudeToolName } from "./hooks/tool-types.ts";

// Compile-coupled to the public union in BOTH directions: `satisfies` rejects a name
// outside the union, and `AssertEqual` fails if the union gains a member the list
// lacks — so a newly typed tool can't be demoted to `unknown:` at runtime.
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const knownToolNameList = [
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
] as const satisfies readonly KnownClaudeToolName[];
const _knownToolNamesCoupled: AssertEqual<(typeof knownToolNameList)[number], KnownClaudeToolName> =
  true;
void _knownToolNamesCoupled;
const knownToolNames: ReadonlySet<string> = new Set(knownToolNameList);

export function normalizeClaudeHookEvent(input: unknown): ClaudeHookEvent {
  const event = input as ClaudeHookEvent;
  if (!("tool_name" in event) || typeof event.tool_name !== "string") return event;
  if (isPublicToolName(event.tool_name)) return event;
  return { ...event, tool_name: `unknown:${event.tool_name}` } as ClaudeHookEvent;
}

function isPublicToolName(value: string): boolean {
  return knownToolNames.has(value) || value.startsWith("mcp__") || value.startsWith("unknown:");
}
