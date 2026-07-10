/**
 * Wires the Claude transcript watcher into the session's activity stream.
 * Implements PRD §5.4 (C-CLAUDE-15): committed assistant text and tool activity
 * come from the transcript(s), so an un-sent ghost-text suggestion never posts.
 */

import * as activity from "../core/activity.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import { ClaudeTranscriptWatcher, type TranscriptDropNotice } from "./transcript.ts";

/** Builds a transcript watcher that emits committed items and drop diagnostics. */
export function createTranscriptWatcher(
  elwoodSessionId: string,
  emitter: TypedEmitter,
): ClaudeTranscriptWatcher {
  return new ClaudeTranscriptWatcher(
    elwoodSessionId,
    (event) => emitter.emit("activity", activity.activityFromClaudeTranscript(event)),
    (notice) => emitter.emit("activity", activity.activityFromWarning(dropWarning(notice))),
  );
}

/**
 * Points the watcher at every transcript path the hook payload carries. A
 * `SubagentStop` event has both a main `transcript_path` and a required
 * `agent_transcript_path`; both must be observed (PRD §5.4). The watcher keeps
 * an independent cursor per path and no-ops on an already-observed path.
 */
export function observeTranscript(
  watcher: ClaudeTranscriptWatcher,
  event: { readonly [key: string]: unknown },
): void {
  for (const key of ["transcript_path", "agent_transcript_path"]) {
    const path = event[key];
    if (typeof path === "string" && path.length > 0) watcher.observe(path);
  }
}

function dropWarning(notice: TranscriptDropNotice): ElwoodWarningEvent {
  return {
    elwoodSessionId: notice.elwoodSessionId,
    agent: "claude",
    source: "terminal",
    code: "transcript_records_dropped",
    severity: "warning",
    message: `Dropped ${notice.droppedCount} unparseable transcript record(s).`,
    droppedCount: notice.droppedCount,
    transcriptPath: notice.path,
    raw: `transcript_records_dropped count=${notice.droppedCount}`,
  };
}
