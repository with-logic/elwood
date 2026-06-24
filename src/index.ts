/**
 * Public package entrypoint.
 * Implements PRD §5.
 */

export type {
  AgentInput,
  AskUserQuestionInput,
  BashInput,
  ClaudeBackgroundTask,
  ClaudeEffortLevel,
  ClaudeHookEvent,
  ClaudeHookEventFor,
  ClaudeHookEventName,
  ClaudeHookHandlers,
  ClaudeHookPermissionMode,
  ClaudeHookResult,
  ClaudeHookResultForEvent,
  ClaudeNotificationType,
  ClaudePostToolBatchCall,
  ClaudeSessionCron,
  ClaudeStopFailureError,
  ClaudeStopFields,
  ClaudeTaskFields,
  ClaudeToolInputUpdateForEvent,
  EditInput,
  ExitPlanModeInput,
  GenericToolInput,
  GlobInput,
  GrepInput,
  PermissionRule,
  PermissionUpdate,
  PermissionUpdateDestination,
  PreToolUseResult,
  ReadInput,
  WebFetchInput,
  WebSearchInput,
  WriteInput,
} from "./claude/hooks.ts";
export { claudeHookEventNames } from "./claude/hooks.ts";
export { resumeClaude, startClaude } from "./claude/session.ts";
export type {
  CodexCommandToolInput,
  CodexCommonHookFields,
  CodexGenericToolInput,
  CodexHookEvent,
  CodexHookEventFor,
  CodexHookEventName,
  CodexHookHandlers,
  CodexHookResult,
  CodexHookResultForEvent,
  CodexKnownToolName,
  CodexPermissionMode,
  CodexPreToolUseResultFor,
  CodexToolEventFields,
  CodexUnknownToolName,
} from "./codex/hooks.ts";
export { codexHookEventNames } from "./codex/hooks.ts";
export { resumeCodex, startCodex } from "./codex/session.ts";
export type {
  CodexApprovalPolicy,
  CodexEventHandler,
  CodexEventMap,
  CodexEventName,
  CodexSandboxMode,
  CodexSession,
  ResumeCodexOptions,
  StartCodexOptions,
} from "./codex/session-types.ts";
export type {
  CodexTranscriptEvent,
  CodexTranscriptSummary,
} from "./codex/transcript.ts";
export type {
  ElwoodActivityEvent,
  ElwoodActivityKind,
  ElwoodActivitySource,
  ElwoodAgentKind,
} from "./core/activity.ts";
export type { ElwoodErrorName } from "./core/errors.ts";
export { ElwoodError, elwoodError } from "./core/errors.ts";
export type {
  ClaudePermissionMode,
  ClaudeSession,
  ClaudeSettingsOverrides,
  ClaudeToolRule,
  ElwoodEventHandler,
  ElwoodEventMap,
  ElwoodEventName,
  ElwoodSessionStatus,
  ElwoodWarningEvent,
  HookErrorEvent,
  ResumeClaudeOptions,
  StartClaudeOptions,
  TerminalSize,
  Unsubscribe,
} from "./core/types.ts";
export type { ElwoodTerminal, TerminalSnapshot, XtermTerminal } from "./terminal/headless.ts";
