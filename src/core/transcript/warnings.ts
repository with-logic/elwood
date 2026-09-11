/**
 * Shared builders for the bounded, content-free transcript diagnostic warnings both
 * adapters surface: `transcript_records_dropped` and `transcript_read_error`.
 * Implements PRD §5.4 (C-CLAUDE-15 / §7A): a dropped record or a contained fs read
 * error becomes ONE live typed `warning` carrying only its cause or error code and
 * path — never raw transcript content, never a running count. The two warnings are
 * byte-identical across adapters except the `agent` tag, so they live here.
 */

import type { ElwoodAgentKind } from "../activity/index.ts";
import type { ElwoodWarningEvent } from "../types.ts";
import type { TranscriptDropNotice, TranscriptReadErrorNotice } from "./drops.ts";

/** Human-readable phrase for each bounded drop cause (no raw content). */
const causePhrase: Record<TranscriptDropNotice["cause"], string> = {
  unparseable: "an unparseable transcript record",
  oversized: "an over-length transcript record",
  unread_backlog: "an unread transcript backlog",
};

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
    message: `Dropped ${causePhrase[notice.cause]}.`,
    cause: notice.cause,
    transcriptPath: notice.path,
    raw: `transcript_records_dropped cause=${notice.cause}`,
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
    message: `Contained a transcript read error (${notice.lastErrorCode}).`,
    lastErrorCode: notice.lastErrorCode,
    transcriptPath: notice.path,
    raw: `transcript_read_error code=${notice.lastErrorCode}`,
  };
}
