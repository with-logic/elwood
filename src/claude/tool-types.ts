/**
 * Claude built-in and extensible tool input types.
 * Implements PRD §6.
 */

import type { ClaudeCommonHookFields } from "./hook-names.ts";

export type BashInput = {
  readonly command: string;
  readonly description?: string;
  readonly timeout?: number;
  readonly run_in_background?: boolean;
};

export type FileInput = { readonly file_path: string };
export type ReadInput = FileInput & { readonly offset?: number; readonly limit?: number };
export type WriteInput = FileInput & { readonly content: string };
export type EditInput = FileInput & {
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
};
export type GlobInput = { readonly pattern: string; readonly path?: string };
export type GrepInput = {
  readonly pattern: string;
  readonly path?: string;
  readonly glob?: string;
  readonly output_mode?: "content" | "files_with_matches" | "count";
  readonly "-i"?: boolean;
  readonly multiline?: boolean;
};
export type WebFetchInput = { readonly url: string; readonly prompt: string };
export type WebSearchInput = {
  readonly query: string;
  readonly allowed_domains?: readonly string[];
  readonly blocked_domains?: readonly string[];
};
export type AgentInput = {
  readonly prompt: string;
  readonly description?: string;
  readonly subagent_type?: string;
  readonly model?: string;
};
export type ExitPlanModeInput = {
  readonly allowedPrompts?: readonly string[];
  readonly plan?: string;
  readonly filePath?: string;
};

export type AskUserQuestionInput = {
  readonly questions: readonly {
    readonly question: string;
    readonly header: string;
    readonly options: readonly { readonly label: string; readonly description?: string }[];
    readonly multiSelect?: boolean;
  }[];
  readonly answers?: Readonly<Record<string, string>>;
};

export type KnownClaudeToolName =
  | "Agent"
  | "AskUserQuestion"
  | "Bash"
  | "Edit"
  | "ExitPlanMode"
  | "Glob"
  | "Grep"
  | "LS"
  | "MultiEdit"
  | "NotebookEdit"
  | "Read"
  | "TodoWrite"
  | "WebFetch"
  | "WebSearch"
  | "Write";

export type UnknownClaudeToolName = `mcp__${string}` | `unknown:${string}`;
export type GenericToolInput = Readonly<Record<string, unknown>>;

export type ClaudeToolInputByName =
  | { readonly tool_name: "Agent"; readonly tool_input: AgentInput }
  | { readonly tool_name: "AskUserQuestion"; readonly tool_input: AskUserQuestionInput }
  | { readonly tool_name: "Bash"; readonly tool_input: BashInput }
  | { readonly tool_name: "Edit"; readonly tool_input: EditInput }
  | { readonly tool_name: "ExitPlanMode"; readonly tool_input: ExitPlanModeInput }
  | { readonly tool_name: "Glob"; readonly tool_input: GlobInput }
  | { readonly tool_name: "Grep"; readonly tool_input: GrepInput }
  | { readonly tool_name: "Read"; readonly tool_input: ReadInput }
  | { readonly tool_name: "WebFetch"; readonly tool_input: WebFetchInput }
  | { readonly tool_name: "WebSearch"; readonly tool_input: WebSearchInput }
  | { readonly tool_name: "Write"; readonly tool_input: WriteInput }
  | { readonly tool_name: GenericKnownToolName; readonly tool_input: GenericToolInput }
  | { readonly tool_name: UnknownClaudeToolName; readonly tool_input: GenericToolInput };

type GenericKnownToolName = Exclude<
  KnownClaudeToolName,
  | "Agent"
  | "AskUserQuestion"
  | "Bash"
  | "Edit"
  | "ExitPlanMode"
  | "Glob"
  | "Grep"
  | "Read"
  | "WebFetch"
  | "WebSearch"
  | "Write"
>;

export type ToolHookEventName =
  | "PermissionDenied"
  | "PermissionRequest"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PreToolUse";

export type ClaudeToolEventFields<E extends ToolHookEventName> = E extends "PreToolUse"
  ? { readonly tool_use_id?: string }
  : E extends "PermissionRequest"
    ? { readonly permission_suggestions?: readonly PermissionUpdate[] }
    : E extends "PostToolUse"
      ? {
          readonly tool_use_id?: string;
          readonly tool_response: unknown;
          readonly duration_ms?: number;
        }
      : E extends "PostToolUseFailure"
        ? {
            readonly tool_use_id?: string;
            readonly error: string;
            readonly is_interrupt?: boolean;
            readonly duration_ms?: number;
          }
        : E extends "PermissionDenied"
          ? { readonly tool_use_id: string; readonly reason: string }
          : Record<string, never>;

export type ClaudeToolEventForName<E extends ToolHookEventName> = ClaudeCommonHookFields & {
  readonly hook_event_name: E;
} & ClaudeToolInputByName &
  ClaudeToolEventFields<E>;

export type ClaudeToolEvent = {
  readonly [E in ToolHookEventName]: ClaudeToolEventForName<E>;
}[ToolHookEventName];

export type PermissionRuleBehavior = "allow" | "deny" | "ask";
export type PermissionUpdateDestination =
  | "session"
  | "localSettings"
  | "projectSettings"
  | "userSettings";

export type PermissionRule = {
  readonly toolName: string;
  readonly ruleContent?: string;
};

export type PermissionUpdate =
  | {
      readonly type: "addRules" | "replaceRules" | "removeRules";
      readonly rules: readonly PermissionRule[];
      readonly behavior: PermissionRuleBehavior;
      readonly destination: PermissionUpdateDestination;
    }
  | {
      readonly type: "setMode";
      readonly mode: import("./hook-names.ts").ClaudeHookPermissionMode;
      readonly destination: PermissionUpdateDestination;
    }
  | {
      readonly type: "addDirectories" | "removeDirectories";
      readonly directories: readonly string[];
      readonly destination: PermissionUpdateDestination;
    };
