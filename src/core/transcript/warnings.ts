/**
 * Shared builders for the bounded, content-free transcript diagnostic warnings both
 * adapters surface: `transcript_records_dropped` and `transcript_read_error`.
 * Implements PRD §5.4 (C-CLAUDE-15 / §7A): a dropped record or a contained fs read
 * error becomes a typed `warning` carrying only counts and a magnitude or error code
 * — never raw transcript content. The two warnings are byte-identical across adapters
 * except the `agent` tag, so they live here; the poll-stopped/final-flush warnings
 * carry adapter-specific phrasing and stay in each adapter's warnings module.
 */

import type { ElwoodAgentKind } from "../activity.ts";
import type { ElwoodWarningEvent } from "../types.ts";
import type { TranscriptDropNotice, TranscriptReadErrorNotice } from "./drops.ts";

/** Human-readable phrase for each bounded drop cause (no raw content). */
const causePhrase: Record<TranscriptDropNotice["cause"], string> = {
  unparseable: "unparseable transcript record(s)",
  oversized: "over-length transcript record(s)",
  unread_backlog: "unread transcript backlog",
};

// `droppedCount` counts LOSS INCIDENTS, not records: each unparseable record, each
// over-length record, and each unread teardown backlog is exactly ONE incident. A
// backlog's record count is unknowable (its bytes are the true magnitude), so the
// message says "loss incident(s)" cause-tagged rather than a false record count.
export function dropWarning(
  agent: ElwoodAgentKind,
  notice: TranscriptDropNotice,
): ElwoodWarningEvent {
  return {
    elwoodSessionId: notice.elwoodSessionId,
    agent,
    source: "terminal",
    code: "transcript_records_dropped",
    severity: "warning",
    message: `Dropped ${notice.droppedCount} transcript loss incident(s) (${notice.droppedBytes} bytes; last cause: ${causePhrase[notice.cause]}).`,
    droppedCount: notice.droppedCount,
    droppedBytes: notice.droppedBytes,
    cause: notice.cause,
    transcriptPath: notice.path,
    raw: `transcript_records_dropped count=${notice.droppedCount} bytes=${notice.droppedBytes} cause=${notice.cause}`,
  };
}

export function readErrorWarning(
  agent: ElwoodAgentKind,
  notice: TranscriptReadErrorNotice,
): ElwoodWarningEvent {
  return {
    elwoodSessionId: notice.elwoodSessionId,
    agent,
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
