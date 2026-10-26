/**
 * Stable public error names and error class.
 * Implements PRD §10.
 */

export type ElwoodErrorName =
  | "unsupported_platform"
  | "claude_not_found"
  | "claude_start_failed"
  | "claude_update_failed"
  | "claude_not_authenticated"
  | "claude_version_unsupported"
  | "claude_invalid_reasoning_effort"
  | "claude_high_trust_conflict"
  | "codex_not_found"
  | "codex_start_failed"
  | "codex_update_failed"
  | "codex_not_authenticated"
  | "codex_version_unsupported"
  | "codex_invalid_reasoning_effort"
  | "codex_high_trust_conflict"
  | "state_not_found"
  | "state_corrupt"
  | "adapter_mismatch"
  | "resume_unavailable"
  | "pty_start_failed"
  | "hook_bridge_failed"
  | "session_not_running"
  | "input_queue_full"
  | "termination_failed"
  | "teardown_failed"
  | "compact_failed"
  | "interrupt_failed"
  | "model_automation_failed"
  | "question_not_found"
  | "invalid_question_answer"
  | "question_answer_failed"
  | "login_failed"
  | "login_timeout"
  | "invalid_image"
  | "image_attach_failed"
  | "invalid_loop"
  | "loop_limit_reached"
  | "loop_not_found"
  | "loop_persistence_failed"
  | "loop_submission_failed"
  | "turn_failed"
  | "wait_timeout";

export class ElwoodError extends Error {
  override readonly name = "ElwoodError";
  readonly code: ElwoodErrorName;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ElwoodErrorName,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function elwoodError(
  code: ElwoodErrorName,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ElwoodError {
  return new ElwoodError(code, message, details);
}

/** Normalize a thrown value into an Error so a non-Error throw never escapes raw. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * The errno string of a thrown value, or `undefined` when it has none. Narrows
 * object-ness FIRST so a thrown `null`/`undefined`/primitive can never make the
 * inspection itself throw a secondary TypeError that would replace the original
 * failure — the caller keeps and rethrows the real thrown value (C-ERR-01).
 */
export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

// System errno names fit easily (the longest, such as EPROTONOSUPPORT, are 15 characters),
// as do Node's own `ERR_*` codes; the cap bounds what a malformed value can add to a line.
const MAX_ERRNO_SUFFIX_LENGTH = 40;
const ERRNO_TOKEN = new RegExp(`^E[A-Z0-9_]{1,${MAX_ERRNO_SUFFIX_LENGTH}}$`);

declare const errnoTokenBrand: unique symbol;

/** A string `isErrnoToken` accepted, so a producer cannot pass unchecked text where one goes. */
export type ErrnoToken = string & { readonly [errnoTokenBrand]: true };

/**
 * True for an errno-shaped token (`EPERM`, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`): fixed by
 * the platform or Node, never process or user content, so it can travel in a public
 * message or a CLI diagnostic.
 */
export function isErrnoToken(value: unknown): value is ErrnoToken {
  return typeof value === "string" && ERRNO_TOKEN.test(value);
}

/**
 * The errno behind a failure: a typed error's `details.errno` (as `causeDetails` records
 * it), else the thrown value's own errno; `undefined` when neither exists. Never throws.
 */
export function underlyingErrno(error: unknown): string | undefined {
  if (!(error instanceof ElwoodError)) return errnoCode(error);
  const errno = error.details["errno"];
  return typeof errno === "string" ? errno : undefined;
}

/**
 * Extracts diagnosable details from an underlying failure (C-ERR-08):
 * message as cause, plus errno/syscall/path when the error exposes them, and the
 * `cleanupErrorCode` of a cleanup that failed after it, when one was attached.
 */
export function causeDetails(error: unknown): Readonly<Record<string, string>> {
  if (!(error instanceof Error)) return { cause: String(error) };
  const details: Record<string, string> = { cause: error.message };
  const { code, syscall, path } = error as NodeJS.ErrnoException;
  const { cleanupErrorCode } = error as { cleanupErrorCode?: unknown };
  if (typeof code === "string") details["errno"] = code;
  if (typeof syscall === "string") details["syscall"] = syscall;
  if (typeof path === "string") details["path"] = path;
  if (typeof cleanupErrorCode === "string") details["cleanupErrorCode"] = cleanupErrorCode;
  return details;
}

/**
 * Diagnosable details for a failed CLI probe (C-ERR-08): stderr plus the
 * runner's typed cause/errno (e.g. `ETIMEDOUT` on a probe timeout, `E2BIG` on
 * output overflow) so a start failure never drops the underlying reason.
 * A login-shell failure (`phase: "login_shell"`) never ran the command, so its stderr is
 * only the user's startup output, which can carry expanded secrets: it is withheld.
 * `cleanupErrorCode` and `cleanupProcessGroupId` appear only when an aborted probe's cleanup
 * stayed unconfirmed. The group id is diagnostic: it may already be reissued to an unrelated
 * group, so it must never be signaled.
 */
export function probeFailureDetails(result: {
  readonly stderr: string;
  readonly error?: {
    readonly code?: string | undefined;
    readonly message: string;
    // Structurally narrower than `string`: the only producer is `abortProbe`, whose
    // `ProbeCleanup` type pins this to the bounded allowlist plus `ETIMEDOUT`. Importing
    // that union here would make `errors.ts` depend on a module that depends on it, so
    // the constraint is enforced at the producer and documented here.
    readonly cleanupErrorCode?: string;
    readonly cleanupProcessGroupId?: number;
    /** The user's login shell, not the probe command, failed (§9.2). */
    readonly phase?: "login_shell";
  };
}): Readonly<Record<string, string | number>> {
  const loginShell = result.error?.phase === "login_shell";
  const details: Record<string, string | number> = { stderr: loginShell ? "" : result.stderr };
  if (result.error) {
    details["cause"] = result.error.message;
    if (typeof result.error.code === "string") details["errno"] = result.error.code;
    if (result.error.phase !== undefined) details["phase"] = result.error.phase;
    if (result.error.cleanupErrorCode !== undefined)
      details["cleanupErrorCode"] = result.error.cleanupErrorCode;
    if (result.error.cleanupProcessGroupId !== undefined)
      details["cleanupProcessGroupId"] = result.error.cleanupProcessGroupId;
  }
  return details;
}
