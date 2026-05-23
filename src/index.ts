/**
 * Public package entrypoint.
 * Implements PRD §5.
 */

export type {
  AskUserQuestionInput,
  BashInput,
  ClaudeHookEvent,
  ClaudeHookEventFor,
  ClaudeHookEventName,
  ClaudeHookHandlers,
  ClaudeHookResult,
  EditInput,
  PreToolUseResult,
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
