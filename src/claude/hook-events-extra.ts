/**
 * Less central Claude hook event payload fragments.
 * Implements PRD §6.
 */

import type { ClaudeStopFailureError, ClaudeStopFields, ClaudeTaskFields } from "./hook-events.ts";
import type { ClaudeCommonHookFields } from "./hook-names.ts";

export type TaskCreatedEvent = ClaudeCommonHookFields &
  ClaudeTaskFields & { readonly hook_event_name: "TaskCreated" };

export type TaskCompletedEvent = ClaudeCommonHookFields &
  ClaudeTaskFields & { readonly hook_event_name: "TaskCompleted" };

export type StopEvent = ClaudeCommonHookFields &
  ClaudeStopFields & { readonly hook_event_name: "Stop" };

export type StopFailureEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "StopFailure";
  readonly error: ClaudeStopFailureError | string;
  readonly error_details?: string;
  readonly last_assistant_message?: string;
};

export type TeammateIdleEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "TeammateIdle";
  readonly teammate_name: string;
  readonly team_name: string;
};

export type ConfigChangeEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "ConfigChange";
  readonly source:
    | "user_settings"
    | "project_settings"
    | "local_settings"
    | "policy_settings"
    | "skills"
    | string;
  readonly file_path?: string;
};

export type CwdChangedEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "CwdChanged";
  readonly old_cwd: string;
  readonly new_cwd: string;
};

export type FileChangedEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "FileChanged";
  readonly file_path: string;
  readonly event: "change" | "add" | "unlink";
};

export type WorktreeCreateEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "WorktreeCreate";
  readonly name: string;
};

export type WorktreeRemoveEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "WorktreeRemove";
  readonly worktree_path: string;
};

export type PreCompactEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "PreCompact";
  readonly trigger: "manual" | "auto";
  readonly custom_instructions: string;
};

export type PostCompactEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "PostCompact";
  readonly trigger: "manual" | "auto";
  readonly compact_summary: string;
};

export type SessionEndEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "SessionEnd";
  readonly reason:
    | "clear"
    | "resume"
    | "logout"
    | "prompt_input_exit"
    | "bypass_permissions_disabled"
    | "other"
    | string;
};

export type ElicitationEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "Elicitation";
  readonly mcp_server_name: string;
  readonly message: string;
  readonly mode?: "form" | "url" | string;
  readonly url?: string;
  readonly elicitation_id?: string;
  readonly requested_schema?: Readonly<Record<string, unknown>>;
};

export type ElicitationResultEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "ElicitationResult";
  readonly mcp_server_name: string;
  readonly action: string;
  readonly mode?: "form" | "url" | string;
  readonly elicitation_id?: string;
  readonly content?: Readonly<Record<string, unknown>>;
};
