/**
 * Runtime validation for hook payloads crossing the bridge boundary.
 * Implements PRD §6.4.
 */

import type { ClaudeHookEventName, ClaudeHookResult } from "../claude/hooks.ts";
import { isClaudeHookInput } from "../claude/validate-input.ts";

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

export const isClaudeHookEvent = isClaudeHookInput;

export function isClaudeHookResult(
  eventName: ClaudeHookEventName,
  value: unknown,
): value is ClaudeHookResult {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if ("permissionDecision" in value) return isPreToolUseResult(eventName, value);
  if ("behavior" in value) return isPermissionRequestResult(eventName, value);
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
): boolean {
  return (
    eventName === "PreToolUse" &&
    isOneOf(value["permissionDecision"], ["allow", "deny", "ask", "defer"]) &&
    optionalString(value["permissionDecisionReason"]) &&
    optionalString(value["additionalContext"])
  );
}

function isPermissionRequestResult(
  eventName: ClaudeHookEventName,
  value: Readonly<Record<string, unknown>>,
): boolean {
  return eventName === "PermissionRequest" && isOneOf(value["behavior"], ["allow", "deny"]);
}

function isElicitationResult(
  eventName: ClaudeHookEventName,
  value: Readonly<Record<string, unknown>>,
): boolean {
  return (
    (eventName === "Elicitation" || eventName === "ElicitationResult") &&
    isOneOf(value["action"], ["accept", "decline", "cancel"])
  );
}

function isBlockResult(
  eventName: ClaudeHookEventName,
  value: Readonly<Record<string, unknown>>,
): boolean {
  return (
    blockResultEvents.has(eventName) &&
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
    value["continue"] === false &&
    optionalString(value["stopReason"])
  );
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
  if (keys.length === 0) return false;
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

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}
