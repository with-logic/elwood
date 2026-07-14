/**
 * The durable, content-free warning for a failed narrow-bootstrap size restore.
 * Implements PRD §5.3 and C-API-39: when Claude bootstraps wide and the deferred
 * restore of the latest requested size hits a real (non-closed) PTY resize error,
 * the session stays at its safe bootstrap width and surfaces the risk as a typed
 * `resize_restore_failed` warning instead of silently swallowing it. The warning
 * carries only the size Elwood tried to restore and a normalized, allowlisted
 * error code — never a raw system message or conversation content.
 */

import type { ElwoodWarningEvent, TerminalSize } from "../core/types.ts";
import { boundedErrorToken, isResizeErrorCode } from "../core/warning-reasons.ts";

export function resizeRestoreFailedWarning(
  elwoodSessionId: string,
  size: TerminalSize,
  error: unknown,
): ElwoodWarningEvent {
  // Only an allowlisted resize errno/error-name survives; any raw system message
  // collapses to `UnknownError` via the shared bounded-token helper (§5.7).
  const errorCode = boundedErrorToken(error, isResizeErrorCode);
  return {
    elwoodSessionId,
    agent: "claude",
    source: "lifecycle",
    code: "resize_restore_failed",
    severity: "warning",
    message: `Could not restore terminal to ${size.cols}x${size.rows} after bootstrap (${errorCode}); staying at bootstrap width.`,
    requestedCols: size.cols,
    requestedRows: size.rows,
    errorCode,
    raw: `resize_restore_failed cols=${size.cols} rows=${size.rows} code=${errorCode}`,
  };
}
