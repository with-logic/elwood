/**
 * Maps committed transcript items (Claude and Codex) to unified activity events.
 * Implements PRD §5.4 (C-CLAUDE-15 and the Codex transcript activity contract).
 */

import type { ClaudeTranscriptEvent } from "../claude/transcript/index.ts";
import type { ClaudeTranscriptSummary } from "../claude/transcript/summary.ts";
import type { CodexTranscriptEvent } from "../codex/transcript.ts";
import type { ElwoodActivityEvent } from "./activity.ts";
import * as meta from "./activity-meta.ts";
import { transcriptActivityKind } from "./hook-result.ts";

export function activityFromCodexTranscript(event: CodexTranscriptEvent): ElwoodActivityEvent {
  return {
    elwoodSessionId: event.elwoodSessionId,
    agent: "codex",
    source: "transcript",
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
export function activityFromClaudeTranscript(event: ClaudeTranscriptEvent): ElwoodActivityEvent {
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

// The per-variant fields, typed off the summary discriminant so each guaranteed
// field is REQUIRED at construction (a widened optional cannot satisfy these).
function claudeActivityFields(
  summary: ClaudeTranscriptSummary,
): Pick<
  ElwoodActivityEvent,
  "kind" | "text" | "toolName" | "toolUseId" | "toolInput" | "toolOutput"
> {
  if (summary.kind === "assistant_message") return { kind: summary.kind, text: summary.text };
  if (summary.kind === "tool_call") {
    return {
      kind: summary.kind,
      toolName: summary.toolName,
      ...(summary.toolUseId === undefined ? {} : { toolUseId: summary.toolUseId }),
      ...(summary.toolInput === undefined ? {} : { toolInput: summary.toolInput }),
    };
  }
  return {
    kind: summary.kind,
    toolUseId: summary.toolUseId,
    ...(summary.toolOutput === undefined ? {} : { toolOutput: summary.toolOutput }),
  };
}
