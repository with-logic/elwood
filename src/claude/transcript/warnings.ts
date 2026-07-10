/**
 * Builds bounded, content-free transcript diagnostic warnings.
 * Implements PRD §5.4 (C-CLAUDE-15): a dropped record or a contained filesystem
 * read error becomes a typed `warning` carrying only counts and a magnitude or
 * error code — never raw transcript content.
 */

import type { ElwoodWarningEvent } from "../../core/types.ts";
import type { PollErrorReason } from "../../core/warning-reasons.ts";
import { isPollErrorReason } from "../../core/warning-reasons.ts";
import type { TranscriptDropNotice, TranscriptReadErrorNotice } from "./drops.ts";

/** Human-readable phrase for each bounded drop cause (no raw content). */
const causePhrase: Record<TranscriptDropNotice["cause"], string> = {
  unparseable: "unparseable transcript record(s)",
  oversized: "over-length transcript record(s)",
  unread_backlog: "unread transcript backlog",
};

export function dropWarning(notice: TranscriptDropNotice): ElwoodWarningEvent {
  return {
    elwoodSessionId: notice.elwoodSessionId,
    agent: "claude",
    source: "terminal",
    code: "transcript_records_dropped",
    severity: "warning",
    message: `Dropped ${notice.droppedCount} transcript record(s) (${notice.droppedBytes} bytes; last cause: ${causePhrase[notice.cause]}).`,
    droppedCount: notice.droppedCount,
    droppedBytes: notice.droppedBytes,
    cause: notice.cause,
    transcriptPath: notice.path,
    raw: `transcript_records_dropped count=${notice.droppedCount} bytes=${notice.droppedBytes} cause=${notice.cause}`,
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

/** Which lifecycle phase surfaced a transcript-processing failure (§5.4). */
export type TranscriptFailurePhase = "poll" | "final_flush";

/** Phase-specific message so an operator can tell WHICH phase failed. */
const phaseMessage: Record<TranscriptFailurePhase, string> = {
  poll: "Transcript polling stopped after an unexpected error.",
  final_flush: "Transcript final flush at exit failed after an unexpected error.",
};

/**
 * A programming error escaped transcript processing; the watcher stopped (§5.4).
 * `phase` records WHERE it escaped — a live periodic poll (`"poll"`) or the final
 * flush at PTY exit (`"final_flush"`) — so a failed shutdown flush (lost trailing
 * activity) is distinguishable from a live-watcher poll failure without a separate
 * warning code. This warning is PERSISTED, and the escaping error can be a
 * downstream activity-listener exception whose message embeds raw transcript items
 * (prompts, tool output, credentials). To honor the content-free warning
 * guarantee (§5.4/§8.3), only a bounded, allowlisted error NAME/errno reaches the
 * persisted fields — never `error.message` or `String(error)`.
 */
export function pollErrorWarning(
  elwoodSessionId: string,
  error: unknown,
  phase: TranscriptFailurePhase = "poll",
): ElwoodWarningEvent {
  const reason = boundedErrorName(error);
  return {
    elwoodSessionId,
    agent: "claude",
    source: "terminal",
    code: "transcript_poll_stopped",
    severity: "warning",
    message: phaseMessage[phase],
    reason,
    phase,
    raw: `transcript_poll_stopped phase=${phase} reason=${reason}`,
  };
}

/**
 * The escaping error mapped to an ALLOWLISTED reason token. `error.name` and
 * `error.code` are caller-controlled — an activity-listener bug can throw an
 * error whose `name`/`code` embeds conversation text — so sanitizing is not
 * enough. Only a value on the fixed allowlist (`POLL_ERROR_REASONS`: the standard
 * JS error constructors + common Node errnos) passes through; anything else
 * collapses to `"UnknownError"`, so no conversation-derived string can reach
 * persisted state.
 */
function boundedErrorName(error: unknown): PollErrorReason {
  const code = (error as { code?: unknown } | null)?.code;
  if (isPollErrorReason(code)) return code;
  if (error instanceof Error && isPollErrorReason(error.name)) return error.name;
  return "UnknownError";
}
