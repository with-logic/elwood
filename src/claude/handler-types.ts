/**
 * Public Claude hook handler map types.
 * Implements PRD §6.4 tool-specific response narrowing.
 */

import type { ClaudeHookEventFor } from "./hooks/events.ts";
import type {
  ClaudeHookResultFor,
  ClaudeHookResultForEvent,
  PermissionRequestCommonResult,
  PreToolUseCommonResult,
} from "./hooks/index.ts";
import type { ClaudeHookEventName } from "./hooks/names.ts";
import type { UnknownClaudeToolName } from "./hooks/tool-types.ts";

type MaybePromise<T> = T | Promise<T>;

type ClaudeToolEventForTool<
  K extends "PermissionRequest" | "PreToolUse",
  Tool extends string,
> = ClaudeHookEventFor<K> & { readonly tool_name: Tool };

type ClaudeToolSpecificHandler<K extends "PermissionRequest" | "PreToolUse"> = {
  readonly [Tool in Exclude<ClaudeHookEventFor<K>["tool_name"], UnknownClaudeToolName> & string]?: (
    event: ClaudeToolEventForTool<K, Tool>,
  ) => MaybePromise<ClaudeHookResultForEvent<ClaudeToolEventForTool<K, Tool>>>;
} & {
  readonly unknown?: (
    event: ClaudeToolEventForTool<K, UnknownClaudeToolName>,
  ) => MaybePromise<ClaudeHookResultForEvent<ClaudeToolEventForTool<K, UnknownClaudeToolName>>>;
};

type ClaudeHandlerFor<K extends ClaudeHookEventName> = K extends "PreToolUse"
  ?
      | ((event: ClaudeHookEventFor<K>) => MaybePromise<PreToolUseCommonResult | undefined>)
      | ClaudeToolSpecificHandler<K>
  : K extends "PermissionRequest"
    ?
        | ((
            event: ClaudeHookEventFor<K>,
          ) => MaybePromise<PermissionRequestCommonResult | undefined>)
        | ClaudeToolSpecificHandler<K>
    : (event: ClaudeHookEventFor<K>) => MaybePromise<ClaudeHookResultFor<K>>;

export type ClaudeHookHandlers = {
  readonly [K in ClaudeHookEventName]?: ClaudeHandlerFor<K>;
};
