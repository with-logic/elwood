/** Event-name hook subscriptions expose decisions and context, without tool-input rewrites (PRD §6.4). */

import type {
  ClaudeHookResultFor,
  PermissionRequestCommonResult,
  PreToolUseCommonResult,
} from "./index.ts";
import type { ClaudeHookEventName } from "./names.ts";

export type ClaudeHookCommonResultFor<K extends ClaudeHookEventName> = K extends "PreToolUse"
  ? PreToolUseCommonResult | undefined
  : K extends "PermissionRequest"
    ? PermissionRequestCommonResult | undefined
    : ClaudeHookResultFor<K>;
