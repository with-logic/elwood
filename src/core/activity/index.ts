/** Unified activity events shared across agent adapters (PRD §5.4). */

import type { ClaudeHookEvent } from "../../claude/hooks/index.ts";
import type { CodexHookEvent } from "../../codex/hooks/index.ts";
import type { ElwoodQuestionEvent } from "../questions/types.ts";
import type { DashboardActivityFields } from "../stats/types.ts";
import type { ElwoodSessionStatus, ElwoodWarningEvent, HookErrorEvent } from "../types.ts";
import * as meta from "./meta.ts";
import { hasPromptText } from "./prompt-text.ts";
import type { SpeedActivityFields } from "./speed.ts";
import type { UnrecognizedStartupActivity } from "./startup.ts";
import type { FinalAssistantActivity } from "./transcript.ts";
import type { TurnFailureActivity } from "./turn-failure.ts";

export type ElwoodAgentKind = "claude" | "codex";
export type ElwoodActivitySource = "hook" | "transcript" | "terminal" | "lifecycle";
export type ElwoodActivityKind =
  | "status"
  | "terminal_exit"
  | "user_message"
  | "assistant_message"
  | "assistant_progress"
  | "question"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "web_search"
  | "other"
  | "notification"
  | "warning"
  | "startup_prompt"
  | "unrecognized_startup"
  | "attention"
  | "hook"
  | "hook_result"
  | "hook_error"
  | "turn_failure";
type ActivityFields = {
  readonly elwoodSessionId: string;
  readonly agent: ElwoodAgentKind;
  readonly source: ElwoodActivitySource;
  readonly label: string;
  readonly text?: string;
  readonly promptGeneration?: number;
  readonly hookEventName?: string;
  readonly turnId?: string;
  readonly toolName?: string;
  readonly toolUseId?: string;
  readonly toolInput?: string;
  readonly toolOutput?: string;
  readonly status?: ElwoodSessionStatus;
  readonly exitCode?: number;
  readonly failedOpen?: boolean;
  readonly transcriptPath?: string;
  readonly raw?: unknown;
};
/** Distribute the agent-and-phase event union so the activity label, nested phase,
 * and both agent fields stay correlated. */
type QuestionActivityFields<Event extends ElwoodQuestionEvent = ElwoodQuestionEvent> =
  Event extends ElwoodQuestionEvent
    ? {
        readonly kind: "question";
        readonly agent: Event["agent"];
        readonly source: "terminal";
        readonly label: Event["phase"];
        readonly question: Event;
      }
    : never;

type UnmarkedActivity =
  | {
      readonly kind: Exclude<
        ElwoodActivityKind,
        "question" | "assistant_progress" | "user_message" | "unrecognized_startup" | "turn_failure"
      >;
    }
  | UnrecognizedStartupActivity
  | {
      readonly kind: "assistant_progress";
      readonly agent: "codex";
      readonly source: "transcript";
      readonly label: "assistant";
      readonly text: string;
      readonly transcriptPath: string;
      readonly raw: unknown;
    }
  | {
      readonly kind: "user_message";
      readonly agent: "claude";
      readonly source: "transcript";
      readonly transcriptPath: string;
      readonly turnId: string;
      readonly label: "user";
      readonly text: string;
    }
  | {
      readonly kind: "user_message";
      readonly source: "hook";
      readonly hookEventName: "UserPromptSubmit";
      readonly label: "user";
      readonly text: string;
    }
  | TurnFailureActivity
  | QuestionActivityFields;

export type ElwoodActivityEvent = ActivityFields &
  DashboardActivityFields &
  SpeedActivityFields &
  (FinalAssistantActivity | (UnmarkedActivity & { readonly final?: never }));

export { activityFromStatus, activityFromTerminalExit, reapFailureWarning } from "./lifecycle.ts";

/** Hook events both adapters map identically; returns undefined for the rest. */
function sharedHookActivity(
  base: ReturnType<typeof meta.hookActivityBase>,
  event: ClaudeHookEvent | CodexHookEvent,
): ElwoodActivityEvent | undefined {
  if (event.hook_event_name === "UserPromptSubmit") {
    return hasPromptText(event.prompt)
      ? {
          ...base,
          kind: "user_message",
          source: "hook",
          hookEventName: "UserPromptSubmit",
          label: "user",
          text: event.prompt,
        }
      : undefined;
  }
  if (event.hook_event_name === "Notification") {
    return { ...base, kind: "notification", label: event.notification_type, text: event.message };
  }
  return undefined;
}

/** Claude tool and assistant events come from the transcript (C-CLAUDE-15). */
export function activityFromClaudeHook(
  elwoodSessionId: string,
  event: ClaudeHookEvent,
): ElwoodActivityEvent {
  const base = meta.hookActivityBase("claude", elwoodSessionId, event);
  const shared = sharedHookActivity(base, event);
  return shared ?? { ...base, kind: "hook", label: event.hook_event_name };
}

/**
 * Codex hook → activity. Codex's `assistant_message`, `tool_call`, and
 * `tool_result` are sourced from the committed `codex:transcript` (C-CODEX-16),
 * so the `Stop`/`PreToolUse`/`PostToolUse` hooks MUST NOT re-project them — that
 * surfaced every reply and every tool step twice (once from the hook, once from
 * the transcript). Those hooks stay plain `hook` turn-boundary signals here, and
 * `Stop`'s `last_assistant_message` (which can be un-submitted ghost text) never
 * becomes an `assistant_message`, exactly as for Claude (C-CLAUDE-15).
 */
export function activityFromCodexHook(
  elwoodSessionId: string,
  event: CodexHookEvent,
): ElwoodActivityEvent {
  const base = meta.hookActivityBase("codex", elwoodSessionId, event);
  const shared = sharedHookActivity(base, event);
  return shared ?? { ...base, kind: "hook", label: event.hook_event_name };
}

export function activityFromHookError(
  agent: ElwoodAgentKind,
  event: HookErrorEvent,
): ElwoodActivityEvent {
  return {
    elwoodSessionId: event.elwoodSessionId,
    agent,
    source: "hook",
    kind: "hook_error",
    label: `${event.hookEventName}:${event.category}`,
    text: event.message,
    hookEventName: event.hookEventName,
    raw: event,
  };
}
export { activityFromHookResult } from "../hook-result.ts";

export function activityFromWarning(event: ElwoodWarningEvent): ElwoodActivityEvent {
  return {
    elwoodSessionId: event.elwoodSessionId,
    agent: event.agent,
    source: event.source,
    kind: "warning",
    label: event.code,
    text: event.message,
    raw: event,
  };
}
export {
  activityFromClaudeTranscript,
  activityFromCodexTranscript,
} from "./transcript.ts";
