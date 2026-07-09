/**
 * Maps committed transcript items (Claude and Codex) to unified activity events.
 * Implements PRD §5.4 (C-CLAUDE-15 and the Codex transcript activity contract).
 */

import type { ClaudeTranscriptEvent } from "../claude/transcript.ts";
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
 * The Claude summary's `kind` is already an activity kind and its text/tool
 * fields are only present when set, so they carry straight across.
 * `assistant_message` here is the committed-turn source of truth (C-CLAUDE-15).
 */
export function activityFromClaudeTranscript(event: ClaudeTranscriptEvent): ElwoodActivityEvent {
  const { kind, label, ...fields } = event.summary;
  return {
    elwoodSessionId: event.elwoodSessionId,
    agent: "claude",
    source: "transcript",
    kind,
    label,
    transcriptPath: event.path,
    ...fields,
    raw: event.item,
  };
}
