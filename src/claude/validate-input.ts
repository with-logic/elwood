/**
 * Runtime validation for Claude hook inputs crossing the bridge.
 * Implements PRD §6.4.
 */

import type { ClaudeHookEvent } from "./hooks.ts";

const toolEvents = new Set([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
]);

export function isClaudeHookInput(value: unknown): value is ClaudeHookEvent {
  if (!isRecord(value)) return false;
  const eventName = value["hook_event_name"];
  if (
    typeof eventName !== "string" ||
    typeof value["session_id"] !== "string" ||
    typeof value["cwd"] !== "string"
  ) {
    return false;
  }
  if (toolEvents.has(eventName)) return hasToolEventFields(eventName, value);
  if (eventName === "SessionStart") return typeof value["source"] === "string";
  if (eventName === "Setup") return isOneOf(value["trigger"], ["init", "maintenance"]);
  if (eventName === "InstructionsLoaded") return hasInstructionsLoaded(value);
  if (eventName === "UserPromptSubmit") return typeof value["prompt"] === "string";
  if (eventName === "UserPromptExpansion") return hasUserPromptExpansion(value);
  if (eventName === "PostToolBatch") return hasPostToolBatch(value["tool_calls"]);
  if (eventName === "Notification") return hasStrings(value, ["message", "notification_type"]);
  if (eventName === "SubagentStart") return hasStrings(value, ["agent_id", "agent_type"]);
  if (eventName === "SubagentStop")
    return hasStrings(value, ["agent_id", "agent_type", "agent_transcript_path"]);
  if (eventName === "TaskCreated" || eventName === "TaskCompleted")
    return hasStrings(value, ["task_id", "task_subject"]);
  if (eventName === "Stop") return optionalBoolean(value["stop_hook_active"]);
  if (eventName === "StopFailure") return typeof value["error"] === "string";
  if (eventName === "TeammateIdle") return hasStrings(value, ["teammate_name", "team_name"]);
  if (eventName === "ConfigChange") return typeof value["source"] === "string";
  if (eventName === "CwdChanged") return hasStrings(value, ["old_cwd", "new_cwd"]);
  if (eventName === "FileChanged")
    return hasStrings(value, ["file_path"]) && isOneOf(value["event"], ["change", "add", "unlink"]);
  if (eventName === "WorktreeCreate") return typeof value["name"] === "string";
  if (eventName === "WorktreeRemove") return typeof value["worktree_path"] === "string";
  if (eventName === "PreCompact")
    return (
      isOneOf(value["trigger"], ["manual", "auto"]) && hasStrings(value, ["custom_instructions"])
    );
  if (eventName === "PostCompact")
    return isOneOf(value["trigger"], ["manual", "auto"]) && hasStrings(value, ["compact_summary"]);
  if (eventName === "SessionEnd") return typeof value["reason"] === "string";
  if (eventName === "Elicitation") return hasStrings(value, ["mcp_server_name", "message"]);
  if (eventName === "ElicitationResult") return hasStrings(value, ["mcp_server_name", "action"]);
  return false;
}

function hasToolEventFields(eventName: string, value: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof value["tool_name"] === "string" &&
    isToolInput(value["tool_name"], value["tool_input"]) &&
    hasToolSpecificEventFields(eventName, value)
  );
}

function hasToolSpecificEventFields(
  eventName: string,
  value: Readonly<Record<string, unknown>>,
): boolean {
  if (eventName === "PostToolUse") return "tool_response" in value;
  if (eventName === "PostToolUseFailure") return typeof value["error"] === "string";
  if (eventName === "PermissionDenied") return hasStrings(value, ["tool_use_id", "reason"]);
  return true;
}

function isToolInput(toolName: string, input: unknown): boolean {
  if (!isRecord(input)) return false;
  if (toolName === "Agent") return typeof input["prompt"] === "string";
  if (toolName === "AskUserQuestion") return isAskUserQuestionInput(input);
  if (toolName === "Bash") return typeof input["command"] === "string";
  if (toolName === "Edit") return hasStrings(input, ["file_path", "old_string", "new_string"]);
  if (toolName === "ExitPlanMode") return true;
  if (toolName === "Glob") return typeof input["pattern"] === "string";
  if (toolName === "Grep") return typeof input["pattern"] === "string";
  if (toolName === "Read") return typeof input["file_path"] === "string";
  if (toolName === "WebFetch") return hasStrings(input, ["url", "prompt"]);
  if (toolName === "WebSearch") return typeof input["query"] === "string";
  if (toolName === "Write") return hasStrings(input, ["file_path", "content"]);
  return true;
}

function hasInstructionsLoaded(value: Readonly<Record<string, unknown>>): boolean {
  return (
    hasStrings(value, ["file_path"]) &&
    isOneOf(value["memory_type"], ["User", "Project", "Local", "Managed"]) &&
    isOneOf(value["load_reason"], [
      "session_start",
      "nested_traversal",
      "path_glob_match",
      "include",
      "compact",
    ])
  );
}

function hasUserPromptExpansion(value: Readonly<Record<string, unknown>>): boolean {
  return (
    hasStrings(value, ["prompt", "command_name"]) &&
    isOneOf(value["expansion_type"], ["slash_command", "mcp_prompt"])
  );
}

function hasPostToolBatch(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => isRecord(item) && hasToolEventFields("PostToolUse", item))
  );
}

function isAskUserQuestionInput(input: Readonly<Record<string, unknown>>): boolean {
  return Array.isArray(input["questions"]) && input["questions"].every(isQuestion);
}

function isQuestion(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasStrings(value, ["question", "header"]) &&
    Array.isArray(value["options"]) &&
    value["options"].every(isQuestionOption) &&
    optionalBoolean(value["multiSelect"])
  );
}

function isQuestionOption(value: unknown): boolean {
  return (
    isRecord(value) && typeof value["label"] === "string" && optionalString(value["description"])
  );
}

function hasStrings(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "string");
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
