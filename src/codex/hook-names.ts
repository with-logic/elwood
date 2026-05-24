/**
 * Codex hook names and common fields.
 * Implements PRD §7A.
 */

export const codexHookEventNames = [
  "SessionStart",
  "SubagentStart",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "UserPromptSubmit",
  "SubagentStop",
  "Stop",
] as const;

export type CodexHookEventName = (typeof codexHookEventNames)[number];

export type CodexPermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "dontAsk"
  | "bypassPermissions";

export type CodexCommonHookFields = {
  readonly session_id: string;
  readonly transcript_path?: string | null;
  readonly cwd: string;
  readonly hook_event_name: CodexHookEventName;
  readonly model: string;
  readonly permission_mode?: CodexPermissionMode;
};

export type CodexTurnFields = { readonly turn_id: string };
