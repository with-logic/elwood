/**
 * Runtime validation for Claude hook inputs crossing the bridge: common fields,
 * then a per-event predicate table keyed by `hook_event_name`.
 * Implements PRD §6.4.
 */

import {
  isOneOf,
  isRecord,
  isString,
  optionalBoolean,
  optionalString,
} from "../../core/predicates.ts";
import type { ClaudeHookEvent } from "../hooks/index.ts";
import {
  type ClaudeEffortLevel,
  type ClaudeHookEventName,
  claudeHookPermissionModes,
} from "../hooks/names.ts";
import { isToolHookEventName } from "../hooks/tool-events.ts";

// Compile-time coupling: the runtime allow-list must stay EXACTLY the public union
// it validates. `AssertEqual` errors if either side gains or loses a member, so a
// new effort level can't silently slip past validation.
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const effortLevels = ["low", "medium", "high", "xhigh", "max"] as const;
const _effortLevelsCoupled: AssertEqual<(typeof effortLevels)[number], ClaudeEffortLevel> = true;
void _effortLevelsCoupled;

type Fields = Readonly<Record<string, unknown>>;
type EventCheck = (value: Fields) => boolean;

const compactTrigger = (value: Fields) => isOneOf(value["trigger"], ["manual", "auto"]);
const strings =
  (...keys: readonly string[]): EventCheck =>
  (value) =>
    hasStrings(value, keys);

// One predicate per non-tool event; tool events share `hasToolEventFields`. The
// table is keyed by the public union so a new event name cannot be forgotten.
const eventChecks: { readonly [E in Exclude<ClaudeHookEventName, ToolEvent>]: EventCheck } = {
  SessionStart: strings("source"),
  Setup: (value) => isOneOf(value["trigger"], ["init", "maintenance"]),
  InstructionsLoaded: hasInstructionsLoaded,
  UserPromptSubmit: strings("prompt"),
  UserPromptExpansion: hasUserPromptExpansion,
  PostToolBatch: (value) => hasPostToolBatch(value["tool_calls"]),
  Notification: strings("message", "notification_type"),
  SubagentStart: strings("agent_id", "agent_type"),
  SubagentStop: strings("agent_id", "agent_type", "agent_transcript_path"),
  TaskCreated: strings("task_id", "task_subject"),
  TaskCompleted: strings("task_id", "task_subject"),
  Stop: (value) => optionalBoolean(value["stop_hook_active"]),
  StopFailure: strings("error"),
  TeammateIdle: strings("teammate_name", "team_name"),
  ConfigChange: strings("source"),
  CwdChanged: strings("old_cwd", "new_cwd"),
  FileChanged: (value) =>
    hasStrings(value, ["file_path"]) && isOneOf(value["event"], ["change", "add", "unlink"]),
  WorktreeCreate: strings("name"),
  WorktreeRemove: strings("worktree_path"),
  PreCompact: (value) =>
    compactTrigger(value) && isNullableOptionalString(value["custom_instructions"]),
  PostCompact: (value) => compactTrigger(value) && hasStrings(value, ["compact_summary"]),
  SessionEnd: strings("reason"),
  Elicitation: strings("mcp_server_name", "message"),
  ElicitationResult: strings("mcp_server_name", "action"),
};
type ToolEvent =
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PermissionDenied";

export function isClaudeHookInput(value: unknown): value is ClaudeHookEvent {
  if (!(isRecord(value) && hasStrings(value, ["hook_event_name", "session_id", "cwd"]))) {
    return false;
  }
  if (!hasValidCommonFields(value)) return false;
  const eventName = value["hook_event_name"] as string;
  if (isToolHookEventName(eventName)) return hasToolEventFields(eventName, value);
  return (
    Object.hasOwn(eventChecks, eventName) &&
    eventChecks[eventName as keyof typeof eventChecks](value)
  );
}

// C-HOOK-07 / C-HOOK-17: typed optional common fields present on every hook
// event must match ClaudeCommonHookFields, not merely be ignored.
function hasValidCommonFields(value: Fields): boolean {
  return (
    optionalString(value["transcript_path"]) &&
    (value["permission_mode"] === undefined ||
      isOneOf(value["permission_mode"], claudeHookPermissionModes)) &&
    isValidEffort(value["effort"])
  );
}

function isValidEffort(value: unknown): boolean {
  if (value === undefined) return true;
  return isRecord(value) && isOneOf(value["level"], effortLevels);
}

function hasToolEventFields(eventName: string, value: Fields): boolean {
  return (
    typeof value["tool_name"] === "string" &&
    isToolInput(value["tool_name"], value["tool_input"]) &&
    hasToolSpecificEventFields(eventName, value)
  );
}

function hasToolSpecificEventFields(eventName: string, value: Fields): boolean {
  if (eventName === "PostToolUse") return "tool_response" in value;
  if (eventName === "PostToolUseFailure") return typeof value["error"] === "string";
  if (eventName === "PermissionDenied") return hasStrings(value, ["tool_use_id", "reason"]);
  return true;
}

const toolInputChecks: Readonly<Record<string, (input: Fields) => boolean>> = {
  Agent: (input) => typeof input["prompt"] === "string",
  AskUserQuestion: isAskUserQuestionInput,
  Bash: (input) => typeof input["command"] === "string",
  Edit: (input) => hasStrings(input, ["file_path", "old_string", "new_string"]),
  Glob: (input) => typeof input["pattern"] === "string",
  Grep: (input) => typeof input["pattern"] === "string",
  Read: (input) => typeof input["file_path"] === "string",
  WebFetch: (input) => hasStrings(input, ["url", "prompt"]),
  WebSearch: (input) => typeof input["query"] === "string",
  Write: (input) => hasStrings(input, ["file_path", "content"]),
};

function isToolInput(toolName: string, input: unknown): boolean {
  if (!isRecord(input)) return false;
  const check = Object.hasOwn(toolInputChecks, toolName) ? toolInputChecks[toolName] : undefined;
  return check === undefined || check(input);
}

function hasInstructionsLoaded(value: Fields): boolean {
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

function hasUserPromptExpansion(value: Fields): boolean {
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

function isAskUserQuestionInput(input: Fields): boolean {
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
  return isRecord(value) && isString(value["label"]) && optionalString(value["description"]);
}

function hasStrings(value: Fields, keys: readonly string[]): boolean {
  return keys.every((key) => isString(value[key]));
}

function isNullableOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}
