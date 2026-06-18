/**
 * Runtime validation for Codex hook payloads and handler results.
 * Implements PRD §7A.2.
 */

import type { CodexHookEvent } from "./hooks.ts";

export { isCodexHookResult } from "./validate-result.ts";

export function normalizeCodexHookEvent(event: CodexHookEvent): CodexHookEvent {
  if (!("tool_name" in event) || isPublicToolName(event.tool_name)) return event;
  return { ...event, tool_name: `unknown:${event.tool_name}` } as CodexHookEvent;
}

export function isCodexHookEvent(value: unknown): value is CodexHookEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (!hasCommonFields(record)) return false;
  const eventName = record["hook_event_name"];
  if (eventName === "SessionStart") return typeof record["source"] === "string";
  if (!hasTurnFields(record)) return false;
  switch (eventName) {
    case "SubagentStart":
      return hasSubagentFields(record);
    case "PreToolUse":
    case "PermissionRequest":
    case "PostToolUse":
      return hasToolFields(record);
    case "PreCompact":
    case "PostCompact":
      return typeof record["trigger"] === "string";
    case "UserPromptSubmit":
      return typeof record["prompt"] === "string";
    case "SubagentStop":
      return (
        hasSubagentFields(record) &&
        hasStopFields(record) &&
        optionalNullableString(record["agent_transcript_path"])
      );
    case "Stop":
      return hasStopFields(record);
    default:
      return false;
  }
}

function hasCommonFields(record: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof record["hook_event_name"] === "string" &&
    typeof record["session_id"] === "string" &&
    typeof record["cwd"] === "string" &&
    optionalString(record["model"]) &&
    optionalPermissionMode(record["permission_mode"])
  );
}

function hasTurnFields(record: Readonly<Record<string, unknown>>): boolean {
  return typeof record["turn_id"] === "string";
}

function hasSubagentFields(record: Readonly<Record<string, unknown>>): boolean {
  return typeof record["agent_id"] === "string" && typeof record["agent_type"] === "string";
}

function hasStopFields(record: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof record["stop_hook_active"] === "boolean" &&
    optionalNullableString(record["last_assistant_message"])
  );
}

function hasToolFields(record: Readonly<Record<string, unknown>>): boolean {
  if (typeof record["tool_name"] !== "string") return false;
  if (!isRecord(record["tool_input"])) return false;
  if (!optionalString(record["tool_use_id"])) return false;
  return isKnownCommandTool(record["tool_name"])
    ? typeof record["tool_input"]["command"] === "string" &&
        optionalNullableString(record["tool_input"]["description"])
    : true;
}

function isKnownCommandTool(value: string): boolean {
  return value === "Bash" || value === "apply_patch";
}

function isPublicToolName(value: string): boolean {
  return isKnownCommandTool(value) || value.startsWith("mcp__") || value.startsWith("unknown:");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function optionalPermissionMode(value: unknown): boolean {
  return (
    value === undefined ||
    isOneOf(value, ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"])
  );
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}
