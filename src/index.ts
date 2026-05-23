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
  ClaudeNotificationType,
  ClaudePostToolBatchCall,
  ClaudeSessionCron,
  ClaudeStopFailureError,
  ClaudeStopFields,
  ClaudeTaskFields,
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
export {
  resetClaudeSessionSeamsForTests,
  resumeClaude,
  setHookBridgeFactoryForTests,
  startClaude,
} from "./claude/session.ts";
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
  HookErrorEvent,
  ResumeClaudeOptions,
  StartClaudeOptions,
  TerminalSize,
  Unsubscribe,
} from "./core/types.ts";
export {
  resetRuntimeSeamsForTests,
  setCommandRunnerForTests,
  setPlatformForTests,
  setPtyFactoryForTests,
} from "./runtime/seams.ts";
