/**
 * The Claude hook events that carry `tool_name`/`tool_input`, as one runtime list
 * with its derived union so validation, settings matchers, and event typing cannot
 * drift apart. Implements PRD §6.1.
 */

import { isOneOf } from "../../core/predicates.ts";

/** The hook events that carry `tool_name`/`tool_input`; the union is derived from it. */
export const toolHookEventNames = [
  "PermissionDenied",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "PreToolUse",
] as const;

export type ToolHookEventName = (typeof toolHookEventNames)[number];

export function isToolHookEventName(value: unknown): value is ToolHookEventName {
  return isOneOf(value, toolHookEventNames);
}
