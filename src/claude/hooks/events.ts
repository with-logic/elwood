/**
 * Claude hook event payload types.
 * Implements PRD §6.
 */

import type {
  ConfigChangeEvent,
  CwdChangedEvent,
  ElicitationEvent,
  ElicitationResultEvent,
  FileChangedEvent,
  PostCompactEvent,
  PreCompactEvent,
  SessionEndEvent,
  StopEvent,
  StopFailureEvent,
  TaskCompletedEvent,
  TaskCreatedEvent,
  TeammateIdleEvent,
  WorktreeCreateEvent,
  WorktreeRemoveEvent,
} from "./events-extra.ts";

export { stopFailureDetails, stopFailureError } from "./events-extra.ts";

import type { ClaudeCommonHookFields, ClaudeHookEventName } from "./names.ts";
import type { ClaudeToolEvent, ClaudeToolInputByName } from "./tool-types.ts";

export type ClaudePostToolBatchCall = ClaudeToolInputByName & {
  readonly tool_use_id?: string;
  readonly tool_response: unknown;
};

export type ClaudeNotificationType =
  | "permission_prompt"
  | "idle_prompt"
  | "auth_success"
  | "elicitation_dialog"
  | "elicitation_complete"
  | "elicitation_response";

export type ClaudeBackgroundTask = {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly description?: string;
  readonly command?: string;
  readonly agent_type?: string;
  readonly server?: string;
  readonly tool?: string;
  readonly name?: string;
};

export type ClaudeSessionCron = {
  readonly id: string;
  readonly schedule: string;
  readonly recurring: boolean;
  readonly prompt: string;
};

export type ClaudeStopFields = {
  readonly stop_hook_active?: boolean;
  readonly last_assistant_message?: string;
  readonly background_tasks?: readonly ClaudeBackgroundTask[];
  readonly session_crons?: readonly ClaudeSessionCron[];
};

export type ClaudeStopFailureError =
  | "rate_limit"
  | "authentication_failed"
  | "oauth_org_not_allowed"
  | "billing_error"
  | "invalid_request"
  | "model_not_found"
  | "server_error"
  | "max_output_tokens"
  | "unknown";

export type ClaudeTaskFields = {
  readonly task_id: string;
  readonly task_subject: string;
  readonly task_description?: string;
  readonly teammate_name?: string;
  readonly team_name?: string;
};

export type ClaudeHookEvent =
  | ClaudeToolEvent
  | SessionStartEvent
  | SetupEvent
  | InstructionsLoadedEvent
  | UserPromptSubmitEvent
  | UserPromptExpansionEvent
  | PostToolBatchEvent
  | NotificationEvent
  | SubagentStartEvent
  | SubagentStopEvent
  | TaskCreatedEvent
  | TaskCompletedEvent
  | StopEvent
  | StopFailureEvent
  | TeammateIdleEvent
  | ConfigChangeEvent
  | CwdChangedEvent
  | FileChangedEvent
  | WorktreeCreateEvent
  | WorktreeRemoveEvent
  | PreCompactEvent
  | PostCompactEvent
  | SessionEndEvent
  | ElicitationEvent
  | ElicitationResultEvent;

export type ClaudeHookEventFor<K extends ClaudeHookEventName> = ClaudeHookEvent extends infer Event
  ? Event extends { readonly hook_event_name: infer EventName }
    ? K extends EventName
      ? Event
      : never
    : never
  : never;

type SessionStartEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "SessionStart";
  readonly source: "startup" | "resume" | "clear" | "compact" | string;
  readonly model?: string;
  readonly agent_type?: string;
};

type SetupEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "Setup";
  readonly trigger: "init" | "maintenance";
};

type InstructionsLoadedEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "InstructionsLoaded";
  readonly file_path: string;
  readonly memory_type: "User" | "Project" | "Local" | "Managed";
  readonly load_reason:
    | "session_start"
    | "nested_traversal"
    | "path_glob_match"
    | "include"
    | "compact";
  readonly globs?: readonly string[];
  readonly trigger_file_path?: string;
  readonly parent_file_path?: string;
};

type UserPromptSubmitEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "UserPromptSubmit";
  readonly prompt: string;
};

type UserPromptExpansionEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "UserPromptExpansion";
  readonly expansion_type: "slash_command" | "mcp_prompt";
  readonly command_name: string;
  readonly command_args?: string;
  readonly command_source?: string;
  readonly prompt: string;
};

type PostToolBatchEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "PostToolBatch";
  readonly tool_calls: readonly ClaudePostToolBatchCall[];
};

type NotificationEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "Notification";
  readonly message: string;
  readonly title?: string;
  readonly notification_type: ClaudeNotificationType | string;
};

type SubagentStartEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "SubagentStart";
  readonly agent_id: string;
  readonly agent_type: string;
};

type SubagentStopEvent = ClaudeCommonHookFields &
  ClaudeStopFields & {
    readonly hook_event_name: "SubagentStop";
    readonly agent_id: string;
    readonly agent_type: string;
    readonly agent_transcript_path: string;
  };
