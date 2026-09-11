/**
 * Claude hook names and common hook fields.
 * Implements PRD §6.
 */

export const claudeHookEventNames = [
  "SessionStart",
  "Setup",
  "InstructionsLoaded",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "PermissionDenied",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "StopFailure",
  "TeammateIdle",
  "ConfigChange",
  "CwdChanged",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
  "Elicitation",
  "ElicitationResult",
] as const;

export type ClaudeHookEventName = (typeof claudeHookEventNames)[number];

/** The permission modes a hook payload may report; the union is derived from it. */
export const claudeHookPermissionModes = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const;

export type ClaudeHookPermissionMode = (typeof claudeHookPermissionModes)[number];

export type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeUnknownHookFields = {
  readonly [key: string]: unknown;
};

export type ClaudeCommonHookFields = {
  readonly session_id: string;
  readonly transcript_path?: string;
  readonly cwd: string;
  readonly permission_mode?: ClaudeHookPermissionMode;
  readonly effort?: { readonly level: ClaudeEffortLevel };
  readonly hook_event_name: ClaudeHookEventName;
} & ClaudeUnknownHookFields;
