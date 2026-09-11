/**
 * The fixed allowlists of bounded reason/error-code tokens carried by content-free
 * warnings, and their derived types + guards.
 * Implements PRD §5.7 (C-CLAUDE-15, C-LIFE-10): the `reason` field of a
 * `transcript_poll_stopped` warning and the `errorCode` field of a `reap_failed`
 * warning may carry ONLY a value from a fixed allowlist — never a raw system
 * message or a caller-controlled string that could leak content into a live
 * warning. This module is the single source of truth the unions and their
 * producers derive from, so a producer and its type can never drift apart.
 */

import { errnoCode } from "../errors.ts";

/** The fixed fallback token every bounded error-token allowlist collapses to. */
export const unknownErrorToken = "UnknownError";

/**
 * Maps an arbitrary thrown value to a bounded, ALLOWLISTED token, shared by every
 * content-free warning that carries a normalized error code (reap, transcript
 * poll, resize restore). An error's `.code` (errno), `Error.name`, and message are
 * all system/caller-controlled and can embed an env path or conversation text, so
 * only a value the caller's `allow` guard accepts passes through; anything else —
 * including a raw system message — collapses to `UnknownError`. This is the single
 * place the sanitizing rule lives, so no producer can weaken it (§5.7).
 */
export function boundedErrorToken<T extends string>(
  error: unknown,
  allow: (value: unknown) => value is T,
): T | typeof unknownErrorToken {
  const code = errnoCode(error);
  if (allow(code)) return code;
  if (error instanceof Error && allow(error.name)) return error.name;
  return unknownErrorToken;
}

/**
 * The allowlisted tokens for `transcript_poll_stopped.reason`: standard JS error
 * constructor names + common Node filesystem/stream errnos, plus the fixed
 * `UnknownError` fallback that any unrecognized value collapses to.
 */
export const pollErrorReasons = [
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
export type PollErrorReason = (typeof pollErrorReasons)[number];

const pollErrorReasonSet: ReadonlySet<string> = new Set(pollErrorReasons);

export function isPollErrorReason(value: unknown): value is PollErrorReason {
  return typeof value === "string" && pollErrorReasonSet.has(value);
}

/**
 * The allowlisted tokens for `reap_failed.errorCode`: standard JS error
 * constructor names + the process-signalling errnos a group SIGKILL can surface,
 * plus the fixed `UnknownError` fallback any unrecognized value collapses to. A
 * reap failure's error `name`/`.code`/message are caller/system-controlled, so
 * only a value on this allowlist may reach the live warning.
 */
export const reapErrorCodes = [
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
export type ReapErrorCode = (typeof reapErrorCodes)[number];

const reapErrorCodeSet: ReadonlySet<string> = new Set(reapErrorCodes);

export function isReapErrorCode(value: unknown): value is ReapErrorCode {
  return typeof value === "string" && reapErrorCodeSet.has(value);
}

/** Why transcript data was lost, so cause is never mislabeled. */
export const dropCauses = ["unparseable", "oversized", "unread_backlog"] as const;

/** A bounded `transcript_records_dropped.cause` token. */
export type DropCause = (typeof dropCauses)[number];

/**
 * The allowlisted tokens for `resize_restore_failed.errorCode`: standard JS error
 * constructor names + the errnos a native PTY resize can surface, plus the fixed
 * `UnknownError` fallback any unrecognized value collapses to. A resize failure's
 * error `name`/`.code`/message are system-controlled, so only a value on this
 * allowlist may reach the live warning (§5.7).
 */
export const resizeErrorCodes = [
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
export type ResizeErrorCode = (typeof resizeErrorCodes)[number];

const resizeErrorCodeSet: ReadonlySet<string> = new Set(resizeErrorCodes);

export function isResizeErrorCode(value: unknown): value is ResizeErrorCode {
  return typeof value === "string" && resizeErrorCodeSet.has(value);
}

/** Which lifecycle phase a transcript failure occurred in. */
export const pollPhases = ["poll", "final_flush"] as const;

/** A bounded `transcript_poll_stopped.phase` token. */
export type PollPhase = (typeof pollPhases)[number];
