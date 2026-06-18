/**
 * Public Claude hook type barrel.
 * Implements PRD §6 and §7.
 */

export type {
  ClaudeBackgroundTask,
  ClaudeHookEvent,
  ClaudeHookEventFor,
  ClaudeNotificationType,
  ClaudePostToolBatchCall,
  ClaudeSessionCron,
  ClaudeStopFailureError,
  ClaudeStopFields,
  ClaudeTaskFields,
} from "./hook-events.ts";
export {
  type ClaudeCommonHookFields,
  type ClaudeEffortLevel,
  type ClaudeHookEventName,
  type ClaudeHookPermissionMode,
  type ClaudeUnknownHookFields,
  claudeHookEventNames,
} from "./hook-names.ts";
export type {
  PermissionRule,
  PermissionRuleBehavior,
  PermissionUpdate,
  PermissionUpdateDestination,
} from "./permissions.ts";
export type {
  AgentInput,
  AskUserQuestionInput,
  BashInput,
  ClaudeToolInputUpdate,
  EditInput,
  ExitPlanModeInput,
  FileInput,
  GenericToolInput,
  GlobInput,
  GrepInput,
  KnownClaudeToolName,
  ReadInput,
  ToolHookEventName,
  UnknownClaudeToolName,
  WebFetchInput,
  WebSearchInput,
  WriteInput,
} from "./tool-types.ts";

import type { ClaudeHookEventFor } from "./hook-events.ts";
import type { ClaudeHookEventName } from "./hook-names.ts";
import type { PermissionUpdate } from "./permissions.ts";
import type { ClaudeToolInputUpdate } from "./tool-types.ts";

export type PreToolUseResult = {
  readonly permissionDecision: "allow" | "deny" | "ask" | "defer";
  readonly permissionDecisionReason?: string;
  readonly updatedInput?: ClaudeToolInputUpdate;
  readonly additionalContext?: string;
};

export type TopLevelBlockResult = {
  readonly decision: "block";
  readonly reason: string;
  readonly additionalContext?: string;
};

export type PermissionRequestResult = {
  readonly behavior: "allow" | "deny";
  readonly updatedInput?: ClaudeToolInputUpdate;
  readonly updatedPermissions?: readonly PermissionUpdate[];
  readonly message?: string;
  readonly interrupt?: boolean;
};

export type PermissionDeniedResult = { readonly retry: true };
export type ContextResult = {
  readonly additionalContext?: string;
  readonly initialUserMessage?: string;
  readonly watchPaths?: readonly string[];
};
export type ContinueFalseResult = { readonly continue: false; readonly stopReason?: string };
export type PostToolUseResult =
  | TopLevelBlockResult
  | {
      readonly additionalContext?: string;
      readonly updatedToolOutput?: unknown;
      readonly updatedMCPToolOutput?: unknown;
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
  | "ConfigChange"
  | "CwdChanged"
  | "FileChanged"
  | "InstructionsLoaded"
  | "Notification"
  | "PermissionDenied"
  | "PermissionRequest"
  | "PostCompact"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PostToolBatch"
  | "PreCompact"
  | "PreToolUse"
  | "SessionEnd"
  | "StopFailure"
  | "Stop"
  | "SubagentStop"
  | "TaskCompleted"
  | "TaskCreated"
  | "TeammateIdle"
  | "UserPromptExpansion"
  | "UserPromptSubmit"
  | "WorktreeCreate"
  | "WorktreeRemove"
>;

export type ClaudeTopLevelBlockHookEventName =
  | "UserPromptSubmit"
  | "UserPromptExpansion"
  | "PostToolUseFailure"
  | "PostToolBatch"
  | "Stop"
  | "SubagentStop"
  | "ConfigChange"
  | "PreCompact";

export type ClaudeContinueFalseHookEventName = "TeammateIdle" | "TaskCreated" | "TaskCompleted";

export type ClaudeHookResultFor<K extends ClaudeHookEventName> = K extends "PreToolUse"
  ? PreToolUseResult | undefined
  : K extends "PermissionRequest"
    ? PermissionRequestResult | undefined
    : K extends "PermissionDenied"
      ? PermissionDeniedResult | undefined
      : K extends "PostToolUse"
        ? PostToolUseResult | undefined
        : K extends ClaudeTopLevelBlockHookEventName
          ? TopLevelBlockResult | undefined
          : K extends ClaudeContinueFalseHookEventName
            ? ContinueFalseResult | undefined
            : K extends "Elicitation" | "ElicitationResult"
              ? ElicitationResult | undefined
              : K extends "WorktreeCreate"
                ? WorktreeCreateResult | undefined
                : K extends ClaudeContextHookEventName
                  ? ContextResult | undefined
                  : undefined;

export type ClaudeHookResult =
  | undefined
  | PreToolUseResult
  | TopLevelBlockResult
  | ContinueFalseResult
  | PermissionRequestResult
  | PermissionDeniedResult
  | ContextResult
  | PostToolUseResult
  | ElicitationResult
  | WorktreeCreateResult;

export type ClaudeHookHandlers = {
  readonly [K in ClaudeHookEventName]?: (
    event: ClaudeHookEventFor<K>,
  ) => ClaudeHookResultFor<K> | Promise<ClaudeHookResultFor<K>>;
};
