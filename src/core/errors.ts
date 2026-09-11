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
  | "codex_not_found"
  | "codex_start_failed"
  | "codex_update_failed"
  | "codex_not_authenticated"
  | "codex_version_unsupported"
  | "codex_invalid_reasoning_effort"
  | "state_not_found"
  | "state_corrupt"
  | "adapter_mismatch"
  | "resume_unavailable"
  | "pty_start_failed"
  | "hook_bridge_failed"
  | "session_not_running"
  | "termination_failed"
  | "teardown_failed"
  | "compact_failed"
  | "interrupt_failed"
  | "model_automation_failed"
  | "login_failed"
  | "login_timeout"
  | "invalid_image"
  | "image_attach_failed"
  | "invalid_loop"
  | "loop_limit_reached"
  | "loop_not_found"
  | "loop_persistence_failed"
  | "loop_submission_failed"
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

/**
 * Extracts diagnosable details from an underlying failure (C-ERR-08):
 * message as cause, plus errno/syscall/path when the error exposes them.
 */
export function causeDetails(error: unknown): Readonly<Record<string, string>> {
  if (!(error instanceof Error)) return { cause: String(error) };
  const details: Record<string, string> = { cause: error.message };
  const { code, syscall, path } = error as NodeJS.ErrnoException;
  if (typeof code === "string") details["errno"] = code;
  if (typeof syscall === "string") details["syscall"] = syscall;
  if (typeof path === "string") details["path"] = path;
  return details;
}

/**
 * Diagnosable details for a failed CLI probe (C-ERR-08): stderr plus the
 * runner's typed cause/errno (e.g. `ETIMEDOUT` on a probe timeout, `E2BIG` on
 * output overflow) so a start failure never drops the underlying reason.
 */
export function probeFailureDetails(result: {
  readonly stderr: string;
  readonly error?: { readonly code?: string | undefined; readonly message: string };
}): Readonly<Record<string, string>> {
  const details: Record<string, string> = { stderr: result.stderr };
  if (result.error) {
    details["cause"] = result.error.message;
    if (typeof result.error.code === "string") details["errno"] = result.error.code;
  }
  return details;
}
