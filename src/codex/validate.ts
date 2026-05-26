/**
 * Runtime validation for Codex hook payloads and handler results.
 * Implements PRD §7A.2.
 */

import type { CodexHookEvent, CodexHookEventName, CodexHookResult } from "./hooks.ts";
import { codexHookEventNames } from "./hooks.ts";

const names = new Set<string>(codexHookEventNames);

export function isCodexHookEvent(value: unknown): value is CodexHookEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (!hasCommonFields(record)) return false;
  const eventName = record["hook_event_name"];
  if (eventName === "SessionStart") return typeof record["source"] === "string";
  if (!hasTurnFields(record)) return false;
  if (eventName === "SubagentStart") return hasSubagentFields(record);
  if (isToolEventName(eventName)) return hasToolFields(record);
  if (eventName === "PreCompact" || eventName === "PostCompact") {
    return typeof record["trigger"] === "string";
  }
  if (eventName === "UserPromptSubmit") return typeof record["prompt"] === "string";
  if (eventName === "SubagentStop") {
    return (
      hasSubagentFields(record) &&
      hasStopFields(record) &&
      optionalNullableString(record["agent_transcript_path"])
    );
  }
  if (eventName === "Stop") return hasStopFields(record);
  return false;
}

export function isCodexHookResult(
  eventName: CodexHookEventName,
  value: unknown,
): value is CodexHookResult {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if ("permissionDecision" in value) return isPreToolUseResult(eventName, value);
  if (eventName === "PreToolUse" && "additionalContext" in value)
    return isPreToolUseResult(eventName, value);
  if ("behavior" in value) return isPermissionRequestResult(eventName, value);
  if ("decision" in value) return isBlockResult(eventName, value);
  return isCommonResult(eventName, value);
}

function isPreToolUseResult(
  eventName: CodexHookEventName,
  value: Readonly<Record<string, unknown>>,
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
    !("additionalContext" in value)
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
    isOneOf(eventName, ["PostToolUse", "UserPromptSubmit", "SubagentStop", "Stop"]) &&
    value["decision"] === "block" &&
    typeof value["reason"] === "string" &&
    optionalString(value["additionalContext"])
  );
}

function isCommonResult(
  eventName: CodexHookEventName,
  value: Readonly<Record<string, unknown>>,
): boolean {
  if (!isOneOf(eventName, ["PostToolUse", "UserPromptSubmit", "SubagentStop", "Stop"]))
    return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  return (
    keysAre(value, ["continue", "stopReason", "systemMessage", "additionalContext"]) &&
    optionalBoolean(value["continue"]) &&
    optionalString(value["stopReason"]) &&
    optionalString(value["systemMessage"]) &&
    optionalString(value["additionalContext"])
  );
}

function keysAre(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasCommonFields(record: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof record["hook_event_name"] === "string" &&
    names.has(record["hook_event_name"]) &&
    typeof record["session_id"] === "string" &&
    typeof record["cwd"] === "string" &&
    optionalString(record["model"])
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

function isToolEventName(value: unknown): boolean {
  return isOneOf(value, ["PreToolUse", "PermissionRequest", "PostToolUse"]);
}

function isKnownCommandTool(value: string): boolean {
  return value === "Bash" || value === "apply_patch";
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

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}
