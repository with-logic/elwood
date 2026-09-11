/**
 * Runtime validation for Codex hook handler results.
 * Implements PRD §7A.2.
 */

import { isOneOf, isRecord, optionalString } from "../../core/predicates.ts";
import type { CodexHookEvent, CodexHookEventName, CodexHookResult } from "./index.ts";

export function isCodexHookResult(
  event: CodexHookEventName | CodexHookEvent,
  value: unknown,
): value is CodexHookResult {
  const eventName = typeof event === "string" ? event : event.hook_event_name;
  const toolName =
    typeof event === "string" || !("tool_name" in event) ? undefined : event.tool_name;
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if ("permissionDecision" in value) return isPreToolUseResult(eventName, value, toolName);
  if (eventName === "PreToolUse" && "additionalContext" in value)
    return isPreToolUseResult(eventName, value, toolName);
  if ("behavior" in value) return isPermissionRequestResult(eventName, value);
  if ("decision" in value) return isBlockResult(eventName, value);
  return isStopResult(eventName, value);
}

function isPreToolUseResult(
  eventName: CodexHookEventName,
  value: Readonly<Record<string, unknown>>,
  toolName?: string,
): boolean {
  if (eventName !== "PreToolUse") return false;
  if (
    !keysAre(value, [
      "permissionDecision",
      "permissionDecisionReason",
      "updatedInput",
      "additionalContext",
    ])
  ) {
    return false;
  }
  if ("additionalContext" in value && !("permissionDecision" in value)) {
    return Object.keys(value).length === 1 && typeof value["additionalContext"] === "string";
  }
  if (value["permissionDecision"] === "deny") {
    return (
      typeof value["permissionDecisionReason"] === "string" &&
      !("updatedInput" in value) &&
      !("additionalContext" in value)
    );
  }
  return (
    value["permissionDecision"] === "allow" &&
    !("permissionDecisionReason" in value) &&
    !("additionalContext" in value) &&
    isCodexToolInputUpdate(toolName, value["updatedInput"])
  );
}

function isPermissionRequestResult(
  eventName: CodexHookEventName,
  value: Readonly<Record<string, unknown>>,
): boolean {
  return (
    eventName === "PermissionRequest" &&
    keysAre(value, ["behavior", "message"]) &&
    isOneOf(value["behavior"], ["allow", "deny"]) &&
    optionalString(value["message"])
  );
}

function isBlockResult(
  eventName: CodexHookEventName,
  value: Readonly<Record<string, unknown>>,
): boolean {
  return (
    isOneOf(eventName, ["SubagentStop", "Stop"]) &&
    value["decision"] === "block" &&
    typeof value["reason"] === "string" &&
    optionalString(value["additionalContext"])
  );
}

function isStopResult(
  eventName: CodexHookEventName,
  value: Readonly<Record<string, unknown>>,
): boolean {
  if (eventName !== "Stop" && eventName !== "SubagentStop") return false;
  return isContinueFalseResult(value);
}

function isContinueFalseResult(value: Readonly<Record<string, unknown>>): boolean {
  return (
    keysAre(value, ["continue", "stopReason", "additionalContext"]) &&
    value["continue"] === false &&
    typeof value["stopReason"] === "string" &&
    optionalString(value["additionalContext"])
  );
}

function keysAre(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isCodexToolInputUpdate(toolName: string | undefined, value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (toolName !== "Bash" && toolName !== "apply_patch") return true;
  return (
    keysAre(value, ["command", "description"]) &&
    optionalString(value["description"]) &&
    ("command" in value ? typeof value["command"] === "string" : true)
  );
}
