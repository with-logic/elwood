/**
 * Builds bounded, content-free transcript diagnostic warnings.
 * Implements PRD §5.4 (C-CLAUDE-15): a dropped record or a contained filesystem
 * read error becomes a typed `warning` carrying only counts and a magnitude or
 * error code — never raw transcript content.
 */

import type { ElwoodWarningEvent } from "../../core/types.ts";
import type { TranscriptDropNotice, TranscriptReadErrorNotice } from "./drops.ts";

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

/**
 * A programming error escaped the transcript poll; the watcher stopped (§5.4).
 * This warning is PERSISTED, and the escaping error can be a downstream
 * activity-listener exception whose message embeds raw transcript items
 * (prompts, tool output, credentials). To honor the content-free warning
 * guarantee (§5.4/§8.3), only a bounded, allowlisted error NAME/errno reaches
 * the persisted fields — never `error.message` or `String(error)`.
 */
export function pollErrorWarning(elwoodSessionId: string, error: unknown): ElwoodWarningEvent {
  const reason = boundedErrorName(error);
  return {
    elwoodSessionId,
    agent: "claude",
    source: "terminal",
    code: "transcript_poll_stopped",
    severity: "warning",
    message: "Transcript polling stopped after an unexpected error.",
    reason,
    raw: `transcript_poll_stopped reason=${reason}`,
  };
}

/**
 * The escaping error mapped to an ALLOWLISTED reason token. `error.name` and
 * `error.code` are caller-controlled — an activity-listener bug can throw an
 * error whose `name`/`code` embeds conversation text — so sanitizing is not
 * enough. Only a value on the fixed allowlist (the standard JS error
 * constructors + common Node errnos) passes through; anything else collapses to
 * `"UnknownError"`, so no conversation-derived string can reach persisted state.
 */
const allowedErrorReasons: ReadonlySet<string> = new Set([
  // Standard ECMAScript error constructor names.
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
  // Common Node.js filesystem/stream errno codes seen on a transcript read.
  "ENOENT",
  "EACCES",
  "EPERM",
  "EISDIR",
  "ENOTDIR",
  "EBADF",
  "EMFILE",
  "ENFILE",
  "ELOOP",
  "ENAMETOOLONG",
  "EBUSY",
  "EAGAIN",
  "EIO",
]);

function boundedErrorName(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && allowedErrorReasons.has(code)) return code;
  if (error instanceof Error && allowedErrorReasons.has(error.name)) return error.name;
  return "UnknownError";
}
