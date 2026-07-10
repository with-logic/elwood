/**
 * Builds bounded, content-free transcript diagnostic warnings.
 * Implements PRD §5.4 (C-CLAUDE-15): a dropped record or a contained filesystem
 * read error becomes a typed `warning` carrying only counts and a magnitude or
 * error code — never raw transcript content.
 */

import type { ElwoodWarningEvent } from "../core/types.ts";
import type { TranscriptDropNotice, TranscriptReadErrorNotice } from "./transcript-drops.ts";

export function dropWarning(notice: TranscriptDropNotice): ElwoodWarningEvent {
  return {
    elwoodSessionId: notice.elwoodSessionId,
    agent: "claude",
    source: "terminal",
    code: "transcript_records_dropped",
    severity: "warning",
    message: `Dropped ${notice.droppedCount} unparseable transcript record(s) (${notice.droppedBytes} bytes).`,
    droppedCount: notice.droppedCount,
    droppedBytes: notice.droppedBytes,
    transcriptPath: notice.path,
    raw: `transcript_records_dropped count=${notice.droppedCount} bytes=${notice.droppedBytes}`,
  };
}

export function readErrorWarning(notice: TranscriptReadErrorNotice): ElwoodWarningEvent {
  return {
    elwoodSessionId: notice.elwoodSessionId,
    agent: "claude",
    source: "terminal",
    code: "transcript_read_error",
    severity: "warning",
    message: `Contained ${notice.errorCount} transcript read error(s) (last: ${notice.lastErrorCode}).`,
    errorCount: notice.errorCount,
    lastErrorCode: notice.lastErrorCode,
    transcriptPath: notice.path,
    raw: `transcript_read_error count=${notice.errorCount} code=${notice.lastErrorCode}`,
  };
}

/** A programming error escaped the transcript poll; the watcher stopped (§5.4). */
export function pollErrorWarning(elwoodSessionId: string, error: unknown): ElwoodWarningEvent {
  const cause = error instanceof Error ? error.message : String(error);
  return {
    elwoodSessionId,
    agent: "claude",
    source: "terminal",
    code: "transcript_poll_stopped",
    severity: "warning",
    message: `Transcript polling stopped after an unexpected error: ${cause}.`,
    reason: cause,
    raw: `transcript_poll_stopped reason=${cause}`,
  };
}
