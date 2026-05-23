/**
 * Strong Claude hook event and response types.
 * Implements PRD §6 and §7.
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

export type ClaudeCommonHookFields = {
  readonly session_id: string;
  readonly transcript_path?: string;
  readonly cwd: string;
  readonly hook_event_name: ClaudeHookEventName;
};

export type BashInput = {
  readonly command: string;
  readonly description?: string;
  readonly timeout?: number;
  readonly run_in_background?: boolean;
};

export type FileInput = { readonly file_path: string };
export type WriteInput = FileInput & { readonly content: string };
export type EditInput = FileInput & {
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
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
  | "AskUserQuestion"
  | "Bash"
  | "Edit"
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
export type ToolHookEventName =
  | "PermissionDenied"
  | "PermissionRequest"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PreToolUse";

export type GenericClaudeHookEventName = Exclude<
  ClaudeHookEventName,
  | ToolHookEventName
  | "Elicitation"
  | "ElicitationResult"
  | "SessionStart"
  | "Stop"
  | "UserPromptSubmit"
>;

export type ClaudeToolEvent =
  | (ClaudeCommonHookFields & {
      readonly hook_event_name: "PreToolUse" | "PermissionRequest";
      readonly tool_name: "Bash";
      readonly tool_input: BashInput;
      readonly tool_use_id?: string;
    })
  | (ClaudeCommonHookFields & {
      readonly hook_event_name: "PreToolUse" | "PermissionRequest";
      readonly tool_name: "Write";
      readonly tool_input: WriteInput;
      readonly tool_use_id?: string;
    })
  | (ClaudeCommonHookFields & {
      readonly hook_event_name: "PreToolUse" | "PermissionRequest";
      readonly tool_name: "Edit";
      readonly tool_input: EditInput;
      readonly tool_use_id?: string;
    })
  | (ClaudeCommonHookFields & {
      readonly hook_event_name: "PreToolUse" | "PermissionRequest";
      readonly tool_name: "AskUserQuestion";
      readonly tool_input: AskUserQuestionInput;
      readonly tool_use_id?: string;
    })
  | (ClaudeCommonHookFields & {
      readonly hook_event_name:
        | "PreToolUse"
        | "PermissionRequest"
        | "PostToolUse"
        | "PostToolUseFailure"
        | "PermissionDenied";
      readonly tool_name: Exclude<
        KnownClaudeToolName,
        "AskUserQuestion" | "Bash" | "Edit" | "Write"
      >;
      readonly tool_input: GenericToolInput;
      readonly tool_use_id?: string;
      readonly tool_response?: unknown;
    })
  | (ClaudeCommonHookFields & {
      readonly hook_event_name:
        | "PreToolUse"
        | "PermissionRequest"
        | "PostToolUse"
        | "PostToolUseFailure"
        | "PermissionDenied";
      readonly tool_name: UnknownClaudeToolName;
      readonly tool_input: GenericToolInput;
      readonly tool_use_id?: string;
      readonly tool_response?: unknown;
    });

export type ClaudeHookEvent =
  | ClaudeToolEvent
  | (ClaudeCommonHookFields & {
      readonly hook_event_name: "UserPromptSubmit";
      readonly prompt: string;
    })
  | (ClaudeCommonHookFields & {
      readonly hook_event_name: "Stop";
      readonly stop_hook_active?: boolean;
    })
  | (ClaudeCommonHookFields & {
      readonly hook_event_name: "SessionStart";
      readonly source: string;
      readonly model?: string;
    })
  | (ClaudeCommonHookFields & {
      readonly hook_event_name: "Elicitation";
      readonly mcp_server_name: string;
      readonly message: string;
    })
  | (ClaudeCommonHookFields & {
      readonly hook_event_name: "ElicitationResult";
      readonly mcp_server_name: string;
      readonly action: string;
    })
  | (ClaudeCommonHookFields & {
      readonly hook_event_name: GenericClaudeHookEventName;
      readonly [key: string]: unknown;
    });

export type ClaudeHookEventFor<K extends ClaudeHookEventName> = ClaudeHookEvent extends infer Event
  ? Event extends { readonly hook_event_name: infer EventName }
    ? K extends EventName
      ? Event
      : never
    : never
  : never;

export type PreToolUseResult = {
  readonly permissionDecision: "allow" | "deny" | "ask" | "defer";
  readonly permissionDecisionReason?: string;
  readonly updatedInput?: unknown;
  readonly additionalContext?: string;
};

export type TopLevelBlockResult = {
  readonly decision: "block";
  readonly reason: string;
  readonly additionalContext?: string;
};

export type PermissionRequestResult = {
  readonly behavior: "allow" | "deny";
  readonly updatedInput?: unknown;
  readonly updatedPermissions?: unknown;
};

export type PermissionDeniedResult = { readonly retry: true };
export type ContextResult = {
  readonly additionalContext?: string;
  readonly initialUserMessage?: string;
  readonly watchPaths?: readonly string[];
};
export type ElicitationResult = {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: Readonly<Record<string, unknown>>;
};
export type WorktreeCreateResult = { readonly worktreePath: string };

export type ClaudeContextHookEventName = Exclude<
  ClaudeHookEventName,
  | "Elicitation"
  | "ElicitationResult"
  | "Notification"
  | "PermissionDenied"
  | "PermissionRequest"
  | "PreToolUse"
  | "Stop"
  | "SubagentStop"
  | "WorktreeCreate"
  | "WorktreeRemove"
>;

export type ClaudeHookResultFor<K extends ClaudeHookEventName> = K extends "PreToolUse"
  ? PreToolUseResult | ContextResult | undefined
  : K extends "PermissionRequest"
    ? PermissionRequestResult | undefined
    : K extends "PermissionDenied"
      ? PermissionDeniedResult | undefined
      : K extends "Stop" | "SubagentStop"
        ? TopLevelBlockResult | ContextResult | undefined
        : K extends "Elicitation" | "ElicitationResult"
          ? ElicitationResult | undefined
          : K extends "WorktreeCreate" | "WorktreeRemove"
            ? WorktreeCreateResult | undefined
            : K extends "Notification"
              ? undefined
              : K extends ClaudeContextHookEventName
                ? ContextResult | undefined
                : ClaudeHookResult;

export type ClaudeHookResult =
  | undefined
  | PreToolUseResult
  | TopLevelBlockResult
  | PermissionRequestResult
  | PermissionDeniedResult
  | ContextResult
  | ElicitationResult
  | WorktreeCreateResult;

export type ClaudeHookHandlers = {
  readonly [K in ClaudeHookEventName]?: (
    event: ClaudeHookEventFor<K>,
  ) => ClaudeHookResultFor<K> | Promise<ClaudeHookResultFor<K>>;
};
