/**
 * Public package entrypoint.
 * Implements PRD §5.
 */

// Narrowing helpers for `StopFailure`, whose failure fields are typed `unknown` so a drifted
// rejection still reaches the reader rather than becoming a `hookError` (C-API-57).
export { stopFailureDetails, stopFailureError } from "./claude/hooks/events.ts";
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
} from "./claude/hooks/index.ts";
export { claudeHookEventNames } from "./claude/hooks/index.ts";
export { listClaudeModels } from "./claude/list-models.ts";
export type { ClaudeLoginMethod, ClaudeLoginOptions } from "./claude/login/types.ts";
export { startClaude } from "./claude/session/index.ts";
export type { ClaudeSessionApi } from "./claude/session/interface.ts";
export { resumeClaude } from "./claude/session/resume.ts";
export {
  type StartOrResumeClaudeOptions,
  startOrResumeClaude,
} from "./claude/session/start-or-resume.ts";
export { ClaudeSession, type ClaudeSessionOptions } from "./claude/simple.ts";
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
} from "./codex/hooks/index.ts";
export { codexHookEventNames } from "./codex/hooks/index.ts";
export { listCodexModels } from "./codex/list-models.ts";
export { startCodex } from "./codex/session/index.ts";
export { resumeCodex } from "./codex/session/resume.ts";
export {
  type StartOrResumeCodexOptions,
  startOrResumeCodex,
} from "./codex/session/start-or-resume.ts";
export type {
  CodexApprovalPolicy,
  CodexEventHandler,
  CodexEventMap,
  CodexEventName,
  CodexSandboxMode,
  CodexSessionApi,
  ResumeCodexOptions,
  StartCodexOptions,
} from "./codex/session/types.ts";
export { CodexSession, type CodexSessionOptions } from "./codex/simple.ts";
export type {
  CodexTranscriptEvent,
  CodexTranscriptSummary,
} from "./codex/transcript/index.ts";
export type {
  ElwoodActivityEvent,
  ElwoodActivityKind,
  ElwoodActivitySource,
  ElwoodAgentKind,
} from "./core/activity/index.ts";
export type {
  ElwoodAgentSession,
  ElwoodCommonEventMap,
  ElwoodCommonEventName,
} from "./core/agent-session.ts";
export type { ElwoodErrorName } from "./core/errors.ts";
export { ElwoodError, elwoodError } from "./core/errors.ts";
export type { ImageFormat, ImageInput, SendOptions } from "./core/images/types.ts";
export { parseLoopCommand } from "./core/loops/parser.ts";
export type {
  ElwoodLoopEvent,
  ElwoodLoopEventSnapshot,
  ElwoodLoopRequest,
  ElwoodLoopSnapshot,
  ElwoodLoopState,
} from "./core/loops/types.ts";
export type { ListModelsOptions } from "./core/models/list.ts";
export type { AgentModelOption } from "./core/models/rows.ts";
export type { ClaudeReasoningEffort, CodexReasoningEffort } from "./core/reasoning-effort.ts";
export type { TurnEvent } from "./core/simple/events.ts";
export type { TurnOptions } from "./core/simple/session.ts";
export type { StartOrResumeResult } from "./core/start-or-resume.ts";
export type {
  ActivityMatch,
  ClaudeEventHandler,
  ClaudeEventMap,
  ClaudeEventName,
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
