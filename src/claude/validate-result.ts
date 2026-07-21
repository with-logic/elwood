/**
 * Runtime validation for Claude hook handler results.
 * Implements PRD §6.4.
 */

import type { ClaudeHookEvent, ClaudeHookEventName, ClaudeHookResult } from "./hooks.ts";
import { isPermissionUpdateArray } from "./validate-permission-update.ts";
import { isClaudeToolInputUpdate } from "./validate-tool-update.ts";

const contextResultEvents = new Set<string>(["SessionStart", "Setup", "SubagentStart"]);
const blockResultEvents = new Set<string>([
  "UserPromptSubmit",
  "UserPromptExpansion",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Stop",
  "SubagentStop",
  "ConfigChange",
  "PreCompact",
]);
const continueFalseEvents = new Set<string>(["TeammateIdle", "TaskCreated", "TaskCompleted"]);

export function isClaudeHookResult(
  event: ClaudeHookEventName | ClaudeHookEvent,
  value: unknown,
): value is ClaudeHookResult {
  const eventName = typeof event === "string" ? event : event.hook_event_name;
  const toolName =
    typeof event === "string" || !("tool_name" in event) || typeof event.tool_name !== "string"
      ? undefined
      : event.tool_name;
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if ("permissionDecision" in value) return isPreToolUseResult(eventName, value, toolName);
  if (eventName === "PreToolUse" && "additionalContext" in value) {
    return isPreToolUseResult(eventName, value, toolName);
  }
  if ("behavior" in value) return isPermissionRequestResult(eventName, value, toolName);
  if ("retry" in value) return eventName === "PermissionDenied" && value["retry"] === true;
  if ("worktreePath" in value) {
    return eventName === "WorktreeCreate" && typeof value["worktreePath"] === "string";
  }
  if ("action" in value) return isElicitationResult(eventName, value);
  if ("decision" in value) return isBlockResult(eventName, value);
  if ("continue" in value) return isContinueFalseResult(eventName, value);
  if (eventName === "PostToolUse") return isPostToolUseResult(value);
  if (!contextResultEvents.has(eventName)) return false;
  return isContextResult(value);
}

function isPreToolUseResult(
  eventName: ClaudeHookEventName,
  value: Readonly<Record<string, unknown>>,
  toolName?: string,
): boolean {
  if (eventName !== "PreToolUse") return false;
  if (!("permissionDecision" in value)) {
    return keysAre(value, ["additionalContext"]) && typeof value["additionalContext"] === "string";
  }
  return (
    keysAre(value, [
      "permissionDecision",
      "permissionDecisionReason",
      "updatedInput",
      "additionalContext",
    ]) &&
    isOneOf(value["permissionDecision"], ["allow", "deny", "ask", "defer"]) &&
    optionalString(value["permissionDecisionReason"]) &&
    optionalString(value["additionalContext"]) &&
    isClaudeToolInputUpdate(toolName, value["updatedInput"])
  );
}

function isPermissionRequestResult(
  eventName: ClaudeHookEventName,
  value: Readonly<Record<string, unknown>>,
  toolName?: string,
): boolean {
  return (
    eventName === "PermissionRequest" &&
    keysAre(value, ["behavior", "updatedInput", "updatedPermissions", "message", "interrupt"]) &&
    isOneOf(value["behavior"], ["allow", "deny"]) &&
    optionalString(value["message"]) &&
    optionalBoolean(value["interrupt"]) &&
    optionalPermissionUpdates(value["updatedPermissions"]) &&
    isClaudeToolInputUpdate(toolName, value["updatedInput"])
  );
}

function optionalPermissionUpdates(value: unknown): boolean {
  return value === undefined || isPermissionUpdateArray(value);
}

function isElicitationResult(
  eventName: ClaudeHookEventName,
  value: Readonly<Record<string, unknown>>,
): boolean {
  return (
    (eventName === "Elicitation" || eventName === "ElicitationResult") &&
    keysAre(value, ["action", "content"]) &&
    isOneOf(value["action"], ["accept", "decline", "cancel"])
  );
}

function isBlockResult(
  eventName: ClaudeHookEventName,
  value: Readonly<Record<string, unknown>>,
): boolean {
  return (
    blockResultEvents.has(eventName) &&
    keysAre(value, ["decision", "reason", "additionalContext"]) &&
    value["decision"] === "block" &&
    typeof value["reason"] === "string" &&
    optionalString(value["additionalContext"])
  );
}

function isContinueFalseResult(
  eventName: ClaudeHookEventName,
  value: Readonly<Record<string, unknown>>,
): boolean {
  return (
    continueFalseEvents.has(eventName) &&
    keysAre(value, ["continue", "stopReason"]) &&
    value["continue"] === false &&
    optionalString(value["stopReason"])
  );
}

function keysAre(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isPostToolUseResult(value: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(value);
  return (
    keys.length > 0 &&
    optionalString(value["additionalContext"]) &&
    keys.every((key) =>
      ["additionalContext", "updatedToolOutput", "updatedMCPToolOutput"].includes(key),
    )
  );
}

function isContextResult(value: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) => key !== "additionalContext" && key !== "initialUserMessage" && key !== "watchPaths",
    )
  ) {
    return false;
  }
  return (
    optionalString(value["additionalContext"]) &&
    optionalString(value["initialUserMessage"]) &&
    optionalStringArray(value["watchPaths"])
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalStringArray(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}
