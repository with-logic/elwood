/**
 * The fixed allowlists of bounded reason/error-code tokens carried by content-free
 * warnings, and their derived types + guards.
 * Implements PRD §5.7 and §8.2 (C-CLAUDE-15, C-LIFE-10): the `reason` field of a
 * `transcript_poll_stopped` warning and the `errorCode` field of a `reap_failed`
 * warning may carry ONLY a value from a fixed allowlist — never a raw system
 * message or a caller-controlled string. This module is the single source of
 * truth those unions, their producers, and persisted-state validation all derive
 * from, so a producer, the type, and the validator can never drift apart.
 */

/**
 * The allowlisted tokens for `transcript_poll_stopped.reason`: standard JS error
 * constructor names + common Node filesystem/stream errnos, plus the fixed
 * `UnknownError` fallback that any unrecognized value collapses to.
 */
export const POLL_ERROR_REASONS = [
  "UnknownError",
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
] as const;

/** A bounded, allowlisted `transcript_poll_stopped.reason` token. */
export type PollErrorReason = (typeof POLL_ERROR_REASONS)[number];

const pollErrorReasons: ReadonlySet<string> = new Set(POLL_ERROR_REASONS);

export function isPollErrorReason(value: unknown): value is PollErrorReason {
  return typeof value === "string" && pollErrorReasons.has(value);
}

/**
 * The allowlisted tokens for `reap_failed.errorCode`: standard JS error
 * constructor names + the process-signalling errnos a group SIGKILL can surface,
 * plus the fixed `UnknownError` fallback any unrecognized value collapses to. A
 * reap failure's error `name`/`.code`/message are caller/system-controlled, so
 * only a value on this allowlist may reach persisted state.
 */
export const REAP_ERROR_CODES = [
  "UnknownError",
  // Standard ECMAScript error constructor names.
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  // Errnos a process-group signal (kill(-pgid, SIGKILL)) can surface.
  "EPERM",
  "ESRCH",
  "EINVAL",
  "EACCES",
  "EAGAIN",
] as const;

/** A bounded, allowlisted `reap_failed.errorCode` token. */
export type ReapErrorCode = (typeof REAP_ERROR_CODES)[number];

const reapErrorCodes: ReadonlySet<string> = new Set(REAP_ERROR_CODES);

export function isReapErrorCode(value: unknown): value is ReapErrorCode {
  return typeof value === "string" && reapErrorCodes.has(value);
}

/** Why transcript data was lost, so cause + cardinality are never mislabeled. */
export const DROP_CAUSES = ["unparseable", "oversized", "unread_backlog"] as const;

/** A bounded `transcript_records_dropped.cause` token. */
export type DropCause = (typeof DROP_CAUSES)[number];

const dropCauses: ReadonlySet<string> = new Set(DROP_CAUSES);

export function isDropCause(value: unknown): value is DropCause {
  return typeof value === "string" && dropCauses.has(value);
}

/**
 * The allowlisted tokens for `resize_restore_failed.errorCode`: standard JS error
 * constructor names + the errnos a native PTY resize can surface, plus the fixed
 * `UnknownError` fallback any unrecognized value collapses to. A resize failure's
 * error `name`/`.code`/message are system-controlled, so only a value on this
 * allowlist may reach persisted state (§5.7).
 */
export const RESIZE_ERROR_CODES = [
  "UnknownError",
  // Standard ECMAScript error constructor names.
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  // Errnos a native PTY resize (ioctl TIOCSWINSZ) or terminal write can surface.
  "EBADF",
  "EINVAL",
  "EIO",
  "ENXIO",
  "EPERM",
  "EACCES",
] as const;

/** A bounded, allowlisted `resize_restore_failed.errorCode` token. */
export type ResizeErrorCode = (typeof RESIZE_ERROR_CODES)[number];

const resizeErrorCodes: ReadonlySet<string> = new Set(RESIZE_ERROR_CODES);

export function isResizeErrorCode(value: unknown): value is ResizeErrorCode {
  return typeof value === "string" && resizeErrorCodes.has(value);
}

/** Which lifecycle phase a transcript failure occurred in. */
export const POLL_PHASES = ["poll", "final_flush"] as const;

/** A bounded `transcript_poll_stopped.phase` token. */
export type PollPhase = (typeof POLL_PHASES)[number];

const pollPhases: ReadonlySet<string> = new Set(POLL_PHASES);

export function isPollPhase(value: unknown): value is PollPhase {
  return typeof value === "string" && pollPhases.has(value);
}
