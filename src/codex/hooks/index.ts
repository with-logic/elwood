/**
 * Public Codex hook event and response types.
 * Implements PRD §7A.
 */

import type { CodexToolEventFields, CodexUnknownToolName } from "../tool-types.ts";
import type { CodexCommonHookFields, CodexHookEventName, CodexTurnFields } from "./names.ts";

type MaybePromise<T> = T | Promise<T>;

export type {
  CodexCommandToolInput,
  CodexGenericToolInput,
  CodexKnownToolName,
  CodexToolEventFields,
  CodexUnknownToolName,
} from "../tool-types.ts";
export type {
  CodexCommonHookFields,
  CodexHookEventName,
  CodexPermissionMode,
} from "./names.ts";
export { codexHookEventNames } from "./names.ts";

type CodexToolEventName = "PreToolUse" | "PermissionRequest" | "PostToolUse";

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

type CodexToolInputUpdateForEvent<Event> = Event extends {
  readonly tool_input: infer Input;
}
  ? Partial<Input>
  : never;

export type CodexPreToolUseResultFor<Event> =
  | { readonly permissionDecision: "deny"; readonly permissionDecisionReason: string }
  | {
      readonly permissionDecision: "allow";
      readonly updatedInput?: CodexToolInputUpdateForEvent<Event>;
    }
  | { readonly additionalContext: string };
export type CodexPreToolUseResult = CodexPreToolUseResultFor<CodexHookEventFor<"PreToolUse">>;
type CodexPreToolUseCommonResult =
  | { readonly permissionDecision: "deny"; readonly permissionDecisionReason: string }
  | { readonly permissionDecision: "allow"; readonly updatedInput?: never }
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

export type CodexHookResultForEvent<Event extends CodexHookEvent> =
  Event["hook_event_name"] extends "PreToolUse"
    ? CodexPreToolUseResultFor<Event> | undefined
    : CodexHookResultFor<Event["hook_event_name"]>;

export type CodexHookResult = {
  [K in CodexHookEventName]: CodexHookResultFor<K>;
}[CodexHookEventName];

type CodexToolEventForTool<Tool extends string> = CodexHookEventFor<"PreToolUse"> & {
  readonly tool_name: Tool;
};

type CodexToolSpecificHandler = {
  readonly [Tool in Exclude<CodexHookEventFor<"PreToolUse">["tool_name"], CodexUnknownToolName> &
    string]?: (
    event: CodexToolEventForTool<Tool>,
  ) => MaybePromise<CodexHookResultForEvent<CodexToolEventForTool<Tool>>>;
} & {
  readonly unknown?: (
    event: CodexToolEventForTool<CodexUnknownToolName>,
  ) => MaybePromise<CodexHookResultForEvent<CodexToolEventForTool<CodexUnknownToolName>>>;
};

type CodexHandlerFor<K extends CodexHookEventName> = K extends "PreToolUse"
  ?
      | ((event: CodexHookEventFor<K>) => MaybePromise<CodexPreToolUseCommonResult | undefined>)
      | CodexToolSpecificHandler
  : (event: CodexHookEventFor<K>) => MaybePromise<CodexHookResultFor<K>>;

export type CodexHookHandlers = {
  readonly [K in CodexHookEventName]?: CodexHandlerFor<K>;
};
