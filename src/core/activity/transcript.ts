/**
 * Maps committed transcript items (Claude and Codex) to unified activity events.
 * Implements PRD §5.4 (C-CLAUDE-15 and the Codex transcript activity contract).
 */

import type { ClaudeTranscriptEvent } from "../../claude/transcript/index.ts";
import type { ClaudeTranscriptSummary } from "../../claude/transcript/summary.ts";
import type { CodexTranscriptEvent } from "../../codex/transcript/index.ts";
import { transcriptActivityKind } from "../hook-result.ts";
import type { ElwoodActivityEvent } from "./index.ts";
import * as meta from "./meta.ts";

export function activityFromCodexTranscript(event: CodexTranscriptEvent): ElwoodActivityEvent {
  const base = {
    elwoodSessionId: event.elwoodSessionId,
    agent: "codex",
    source: "transcript",
  } as const;
  if (event.summary.kind === "commentary")
    return {
      ...base,
      kind: transcriptActivityKind(event.summary.kind),
      label: event.summary.label,
      text: event.summary.text,
      ...meta.transcriptActivityMeta(event),
      raw: event.item,
    };
  return {
    ...base,
    kind: transcriptActivityKind(event.summary.kind),
    label: event.summary.label,
    ...(event.summary.text === undefined ? {} : { text: event.summary.text }),
    ...meta.transcriptActivityMeta(event),
    raw: event.item,
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
  const base = {
    elwoodSessionId: event.elwoodSessionId,
    agent: "claude",
    source: "transcript",
    label: event.summary.label,
    transcriptPath: event.path,
    raw: event.item,
  } as const;
  return { ...base, ...claudeActivityFields(event.summary) };
}

// Distribute over summaries so required payloads remain required in each variant.
type ClaudeActivityFields<Summary extends ClaudeTranscriptSummary = ClaudeTranscriptSummary> =
  Summary extends ClaudeTranscriptSummary ? Omit<Summary, "label"> : never;

function claudeActivityFields(summary: ClaudeTranscriptSummary): ClaudeActivityFields {
  switch (summary.kind) {
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
