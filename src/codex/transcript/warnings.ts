/**
 * Builds bounded, content-free Codex transcript diagnostic warnings.
 * Implements PRD §7A/§5.4: a dropped record or a contained filesystem read error
 * becomes a typed `warning` carrying only counts and a magnitude or error code —
 * never raw transcript content. Mirrors Claude's transcript/warnings builders so
 * both adapters surface identical, shared `transcript_records_dropped` /
 * `transcript_read_error` warnings.
 */

import type { ElwoodWarningEvent } from "../../core/types.ts";
import type { CodexDropNotice, CodexReadErrorNotice } from "./drops.ts";

/** Human-readable phrase for each bounded drop cause (no raw content). */
const causePhrase: Record<CodexDropNotice["cause"], string> = {
  unparseable: "unparseable transcript record(s)",
  oversized: "over-length transcript record(s)",
  unread_backlog: "unread transcript backlog",
};

// `droppedCount` counts LOSS INCIDENTS, not records: each unparseable record, each
// over-length record, and each unread teardown backlog is exactly ONE incident. A
// backlog's record count is unknowable (its bytes are the true magnitude), so the
// message says "loss incident(s)" cause-tagged rather than a false record count.
export function codexDropWarning(notice: CodexDropNotice): ElwoodWarningEvent {
  return {
    elwoodSessionId: notice.elwoodSessionId,
    agent: "codex",
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

export function codexReadErrorWarning(notice: CodexReadErrorNotice): ElwoodWarningEvent {
  return {
    elwoodSessionId: notice.elwoodSessionId,
    agent: "codex",
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
