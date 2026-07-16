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
  KnownClaudeToolName,
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
export { listClaudeModels } from "./claude/list-models.ts";
export type { ClaudeLoginMethod, ClaudeLoginOptions } from "./claude/login/types.ts";
export { startClaude } from "./claude/session.ts";
export type { ClaudeSession } from "./claude/session-interface.ts";
export { resumeClaude } from "./claude/session-resume.ts";
export { type StartOrResumeClaudeOptions, startOrResumeClaude } from "./claude/start-or-resume.ts";
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
export { listCodexModels } from "./codex/list-models.ts";
export { startCodex } from "./codex/session.ts";
export { resumeCodex } from "./codex/session-resume.ts";
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
export { type StartOrResumeCodexOptions, startOrResumeCodex } from "./codex/start-or-resume.ts";
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
export type {
  ElwoodAgentSession,
  ElwoodCommonEventMap,
  ElwoodCommonEventName,
} from "./core/agent-session.ts";
export type { ElwoodErrorName } from "./core/errors.ts";
export { ElwoodError, elwoodError } from "./core/errors.ts";
export type { ListModelsOptions } from "./core/list-models.ts";
export type { AgentModelOption } from "./core/model-rows.ts";
export type { StartOrResumeResult } from "./core/start-or-resume.ts";
export type {
  ActivityMatch,
  ClaudePermissionMode,
  ClaudeSettingsOverrides,
  ClaudeToolRule,
  ElwoodEventHandler,
  ElwoodEventMap,
  ElwoodEventName,
  ElwoodSessionStatus,
  ElwoodStatusDecision,
  ElwoodStatusEvidence,
  ElwoodWarningEvent,
  HookErrorEvent,
  ResumeClaudeOptions,
  StartClaudeOptions,
  StatusMatch,
  TerminalSize,
  Unsubscribe,
} from "./core/types.ts";
export type { ElwoodTerminal, TerminalSnapshot, XtermTerminal } from "./terminal/headless.ts";
