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
  | "codex_not_found"
  | "codex_start_failed"
  | "codex_update_failed"
  | "codex_not_authenticated"
  | "codex_version_unsupported"
  | "state_not_found"
  | "state_corrupt"
  | "adapter_mismatch"
  | "resume_unavailable"
  | "pty_start_failed"
  | "hook_bridge_failed"
  | "session_not_running"
  | "termination_failed"
  | "teardown_failed";

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
