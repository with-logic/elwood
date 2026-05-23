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
  AgentInput,
  AskUserQuestionInput,
  BashInput,
  EditInput,
  ExitPlanModeInput,
  FileInput,
  GenericToolInput,
  GlobInput,
  GrepInput,
  KnownClaudeToolName,
  PermissionRule,
  PermissionRuleBehavior,
  PermissionUpdate,
  PermissionUpdateDestination,
  ReadInput,
  ToolHookEventName,
  UnknownClaudeToolName,
  WebFetchInput,
  WebSearchInput,
  WriteInput,
} from "./tool-types.ts";

import type { ClaudeHookEventFor } from "./hook-events.ts";
import type { ClaudeHookEventName } from "./hook-names.ts";
import type { PermissionUpdate } from "./tool-types.ts";

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
