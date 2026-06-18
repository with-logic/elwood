/**
 * Public Codex hook event and response types.
 * Implements PRD §7A.
 */

import type { CodexCommonHookFields, CodexHookEventName, CodexTurnFields } from "./hook-names.ts";
import type { CodexGenericToolInput, CodexToolEventFields } from "./tool-types.ts";

export type {
  CodexCommonHookFields,
  CodexHookEventName,
  CodexPermissionMode,
} from "./hook-names.ts";
export { codexHookEventNames } from "./hook-names.ts";
export type {
  CodexCommandToolInput,
  CodexGenericToolInput,
  CodexKnownToolName,
  CodexToolEventFields,
  CodexUnknownToolName,
} from "./tool-types.ts";

export type CodexToolEventName = "PreToolUse" | "PermissionRequest" | "PostToolUse";

export type CodexToolEvent = CodexCommonHookFields &
  CodexTurnFields &
  CodexToolEventFields & { readonly hook_event_name: CodexToolEventName };

export type CodexHookEvent =
  | (CodexCommonHookFields & { readonly hook_event_name: "SessionStart"; readonly source: string })
  | (CodexCommonHookFields &
      CodexTurnFields & {
        readonly hook_event_name: "SubagentStart";
        readonly agent_id: string;
        readonly agent_type: string;
      })
  | CodexToolEvent
  | (CodexCommonHookFields &
      CodexTurnFields & {
        readonly hook_event_name: "PreCompact" | "PostCompact";
        readonly trigger: string;
      })
  | (CodexCommonHookFields &
      CodexTurnFields & { readonly hook_event_name: "UserPromptSubmit"; readonly prompt: string })
  | (CodexCommonHookFields &
      CodexTurnFields & {
        readonly hook_event_name: "SubagentStop";
        readonly agent_id: string;
        readonly agent_type: string;
        readonly agent_transcript_path?: string | null;
        readonly stop_hook_active: boolean;
        readonly last_assistant_message?: string | null;
      })
  | (CodexCommonHookFields &
      CodexTurnFields & {
        readonly hook_event_name: "Stop";
        readonly stop_hook_active: boolean;
        readonly last_assistant_message?: string | null;
      });

export type CodexHookEventFor<K extends CodexHookEventName> = CodexHookEvent extends infer Event
  ? Event extends { readonly hook_event_name: infer EventName }
    ? K extends EventName
      ? Event & { readonly hook_event_name: K }
      : never
    : never
  : never;

export type CodexPreToolUseResult =
  | { readonly permissionDecision: "deny"; readonly permissionDecisionReason: string }
  | { readonly permissionDecision: "allow"; readonly updatedInput?: CodexGenericToolInput }
  | { readonly additionalContext: string };

export type CodexPermissionRequestResult = {
  readonly behavior: "allow" | "deny";
  readonly message?: string;
};

export type CodexBlockResult = {
  readonly decision: "block";
  readonly reason: string;
  readonly additionalContext?: string;
};

export type CodexStopResult = {
  readonly continue: false;
  readonly stopReason: string;
  readonly additionalContext?: string;
};

/** Return undefined for no decision; empty objects are invalid and fail open. */
export type CodexHookResultFor<K extends CodexHookEventName> = K extends "PreToolUse"
  ? CodexPreToolUseResult | undefined
  : K extends "PermissionRequest"
    ? CodexPermissionRequestResult | undefined
    : K extends "Stop" | "SubagentStop"
      ? CodexBlockResult | CodexStopResult | undefined
      : undefined;

export type CodexHookResult = {
  [K in CodexHookEventName]: CodexHookResultFor<K>;
}[CodexHookEventName];

export type CodexHookHandlers = {
  readonly [K in CodexHookEventName]?: (
    event: CodexHookEventFor<K>,
  ) => CodexHookResultFor<K> | Promise<CodexHookResultFor<K>>;
};
