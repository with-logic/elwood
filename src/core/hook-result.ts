/**
 * Hook result activity and transcript kind mappings. Implements PRD §5.4 and §5.12.
 */

import type { CodexTranscriptSummary } from "../codex/transcript/types.ts";
import type { ElwoodActivityEvent, ElwoodActivityKind, ElwoodAgentKind } from "./activity/index.ts";
import { field } from "./stats/fields.ts";
import type { SubagentObservation } from "./stats/types.ts";

export function activityFromHookResult(
  agent: ElwoodAgentKind,
  elwoodSessionId: string,
  hookEventName: string,
  result: unknown,
  failedOpen: boolean,
  subagent?: SubagentObservation,
): ElwoodActivityEvent {
  return {
    elwoodSessionId,
    agent,
    source: "hook",
    kind: "hook_result",
    label: hookResultLabel(result, failedOpen),
    hookEventName,
    failedOpen,
    ...field("subagent", subagent),
    raw: { hookEventName, result, failedOpen },
  };
}

export function hookResultLabel(result: unknown, failedOpen: boolean): string {
  if (failedOpen) return "error";
  if (result === undefined) return "no decision";
  if (!result || typeof result !== "object") return "response";
  const record = result as Record<string, unknown>;
  if (typeof record["permissionDecision"] === "string") return record["permissionDecision"];
  if (typeof record["behavior"] === "string") return record["behavior"];
  if (typeof record["decision"] === "string") return record["decision"];
  if (typeof record["additionalContext"] === "string") return "context";
  if (typeof record["action"] === "string") return record["action"];
  if (record["retry"] === true) return "retry";
  if (typeof record["worktreePath"] === "string") return "worktree";
  return "response";
}

const transcriptActivityKinds = {
  commentary: "assistant_progress",
  message: "assistant_message",
  tool_call: "tool_call",
  tool_result: "tool_result",
  reasoning: "reasoning",
  web_search: "web_search",
  other: "other",
} as const satisfies Record<CodexTranscriptSummary["kind"], ElwoodActivityKind>;

export function transcriptActivityKind<Kind extends CodexTranscriptSummary["kind"]>(
  kind: Kind,
): (typeof transcriptActivityKinds)[Kind] {
  return transcriptActivityKinds[kind];
}
