/**
 * Maps committed transcript items (Claude and Codex) to unified activity events.
 * Implements PRD §5.4 (C-CLAUDE-15 and the Codex transcript activity contract).
 */

import type { ClaudeTranscriptEvent } from "../../claude/transcript/index.ts";
import { claudeSpeedObservation } from "../../claude/transcript/speed.ts";
import type { CodexTranscriptEvent } from "../../codex/transcript/index.ts";
import { codexSpeedObservation } from "../../codex/transcript/speed.ts";
import { codexStats } from "../../codex/transcript/stats.ts";
import { codexFinalReplyText } from "../../codex/transcript/summary.ts";
import { transcriptActivityKind } from "../hook-result.ts";
import { optional } from "../optional.ts";
import type { ElwoodActivityEvent } from "./index.ts";
import * as meta from "./meta.ts";

/** Native final reply text. An absent marker leaves finality unknown. */
export type FinalAssistantActivity = {
  readonly kind: "assistant_message";
  readonly source: "transcript";
  readonly text: string;
  readonly final: true;
};

export function activityFromCodexTranscript(event: CodexTranscriptEvent): ElwoodActivityEvent {
  const base = {
    elwoodSessionId: event.elwoodSessionId,
    agent: "codex",
    source: "transcript",
    label: event.summary.label,
    ...meta.transcriptActivityMeta(event),
    raw: event.item,
  } as const;
  if (event.summary.kind === "commentary")
    return {
      ...base,
      kind: transcriptActivityKind(event.summary.kind),
      label: event.summary.label,
      text: event.summary.text,
    };
  const observations = { ...codexSpeedObservation(event.item), ...codexStats(event.item) };
  const finalText = codexFinalReplyText(event);
  if (finalText !== undefined)
    return { ...base, ...observations, kind: "assistant_message", text: finalText, final: true };
  return {
    ...base,
    ...observations,
    kind: transcriptActivityKind(event.summary.kind),
    ...optional(event.summary.text, "text"),
  };
}

/**
 * Projects a committed Claude summary into activity. Rather than spreading the
 * summary's fields (which would WIDEN each per-variant guarantee back to
 * optional), it switches on the discriminant and builds each variant explicitly,
 * so the compiler enforces C-CLAUDE-15's required fields AT THIS BOUNDARY: an
 * `assistant_message` must carry `text`, a `tool_call` its `toolName`, and a
 * `tool_result` its correlating `toolUseId`. A future summary variant that omits
 * one fails to typecheck here rather than silently producing a field-less event.
 */
export function activityFromClaudeTranscript(
  event: ClaudeTranscriptEvent,
): ElwoodActivityEvent & ClaudeActivityFields {
  const origin = {
    elwoodSessionId: event.elwoodSessionId,
    agent: "claude",
    source: "transcript",
    transcriptPath: event.path,
  } as const;
  if (event.recovered) {
    return {
      ...origin,
      kind: "user_message",
      label: "user",
      text: event.summary.text,
      turnId: event.turnId,
    };
  }
  const base = {
    ...origin,
    label: event.summary.label,
    ...optional(event.turnId, "turnId"),
    ...(event.summary.kind === "other" ? {} : { raw: event.item }),
    ...claudeSpeedObservation(event.item),
    ...optional(event.tokenUsage, "tokenUsage"),
  } as const;
  if (event.final)
    return { ...base, kind: "assistant_message", text: event.summary.text, final: true };
  return { ...base, ...claudeActivityFields(event.summary) };
}

// Distribute over summaries so required payloads remain required in each variant.
type ClaudeSummary = ClaudeTranscriptEvent["summary"];
type ClaudeActivityFields<Summary extends ClaudeSummary = ClaudeSummary> =
  Summary extends ClaudeSummary ? Omit<Summary, "label"> : never;

function claudeActivityFields(
  summary: Exclude<ClaudeSummary, { readonly kind: "user_message" }>,
): Exclude<ClaudeActivityFields, { readonly kind: "user_message" }> {
  switch (summary.kind) {
    case "other":
      return { kind: "other" };
    case "assistant_message":
    case "reasoning":
      return { kind: summary.kind, text: summary.text };
    case "tool_call":
      return {
        kind: summary.kind,
        toolName: summary.toolName,
        ...(summary.toolUseId === undefined ? {} : { toolUseId: summary.toolUseId }),
        ...(summary.toolInput === undefined ? {} : { toolInput: summary.toolInput }),
      };
    case "tool_result":
      return {
        kind: summary.kind,
        toolUseId: summary.toolUseId,
        ...(summary.toolOutput === undefined ? {} : { toolOutput: summary.toolOutput }),
      };
  }
}
