/**
 * Less central Claude hook event payload fragments.
 * Implements PRD §6.
 */

import type { ClaudeStopFields, ClaudeTaskFields } from "./events.ts";
import type { ClaudeCommonHookFields } from "./names.ts";

export type TaskCreatedEvent = ClaudeCommonHookFields &
  ClaudeTaskFields & { readonly hook_event_name: "TaskCreated" };

export type TaskCompletedEvent = ClaudeCommonHookFields &
  ClaudeTaskFields & { readonly hook_event_name: "TaskCompleted" };

export type StopEvent = ClaudeCommonHookFields &
  ClaudeStopFields & { readonly hook_event_name: "Stop" };

/**
 * Claude REJECTING a turn. The failure fields are deliberately loose: a `StopFailure` must reach
 * the failure reader even when its payload drifts, because the hook's IDENTITY is the evidence
 * (C-API-57, #19). Ingress therefore admits missing/restructured values, and this type says so
 * rather than promising a shape handlers could not rely on — a type that over-promises is how a
 * typed handler receives an "impossible" value and throws.
 */
export type StopFailureEvent = ClaudeCommonHookFields & {
  readonly hook_event_name: "StopFailure";
  /**
   * The CLI's reported cause. Typed `unknown` because that is what ingress actually admits:
   * a drifted `StopFailure` must reach the failure reader rather than becoming a `hookError`
   * (C-API-57), so the validator accepts any shape — including `null` and objects. A narrower
   * type here would be a promise the validator does not keep, and consumers would narrow
   * nothing while still receiving drifted values. Use `stopFailureError` to read it safely.
   */
  readonly error?: unknown;
  readonly error_details?: unknown;
  readonly last_assistant_message?: unknown;
};

/**
 * The `StopFailure` cause as a string, or `undefined` when the CLI sent a drifted/absent value.
 * The event's own `error` is `unknown` (ingress admits any shape so a rejection is never lost),
 * so consumers narrow through here instead of asserting a type the validator does not enforce.
 */
export function stopFailureError(event: StopFailureEvent): string | undefined {
  return typeof event.error === "string" ? event.error : undefined;
}

/**
 * The `StopFailure` human-readable detail, or `undefined` when absent, blank, or drifted.
 * Blank counts as absent: a whitespace-only detail is as useless to a consumer as none.
 */
export function stopFailureDetails(event: StopFailureEvent): string | undefined {
  const details = event.error_details;
  return typeof details === "string" && details.trim().length > 0 ? details : undefined;
}

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
  // Real manual /compact invocations deliver null custom instructions.
  readonly custom_instructions?: string | null;
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
