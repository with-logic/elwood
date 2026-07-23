/**
 * Shared startup-frame helpers keeping telemetry off the critical frame path.
 * Implements PRD §5.7/§9.1 (C-API-14, C-API-37): a warning is TELEMETRY and must
 * never control session progress. On the hot terminal-frame callback a throwing
 * `warning`/`activity` listener must not skip the rest of the frame (readiness
 * detection, prompt automation, login/attention detection, `terminal:data`), and the
 * preflight/version warning must reach a caller that subscribes in the same turn it
 * receives the session — so it is delivered on a deferred macrotask AFTER start
 * resolves, not on an early startup frame a caller cannot yet observe.
 */

import type { ElwoodWarningEvent } from "./types.ts";

/** A session's live warning sink (emits a batch as `warning` + `activity`). */
export type FrameWarningSink = {
  readonly emitWarnings: (warnings: readonly ElwoodWarningEvent[]) => void;
};

/**
 * Delivers `warnings` through `sink` but CONTAINS a throwing listener so frame
 * processing continues. Warnings are live-only: a contained throw drops the warning
 * (it is not retried), exactly as a human's terminal does not re-show a flashed banner.
 */
export function deliverFrameWarnings(
  sink: FrameWarningSink | undefined,
  warnings: readonly ElwoodWarningEvent[],
): void {
  if (!sink || warnings.length === 0) return;
  try {
    sink.emitWarnings(warnings);
  } catch {
    // Telemetry must not wedge the frame: a throwing listener is contained here so
    // readiness, prompt automation, login detection, and terminal:data still run.
  }
}

/**
 * Schedules the one-shot preflight/version warning for delivery AFTER the session is
 * returned AND the caller's synchronous continuation runs, so a caller attaching a
 * `warning` listener in the same turn it receives the session still observes it
 * (C-API-14) — without restoring general late-subscriber replay. Delivery is deferred
 * to the next macrotask (not a microtask): a microtask scheduled here runs BEFORE the
 * caller's post-`await` continuation (the caller's continuation is itself queued only
 * when start resolves, after this schedule), so it would fire into no listener. A
 * throwing listener is contained. No-op when there is no preflight warning. The timer
 * is unref'd so a pending delivery never keeps the process alive.
 */
export function schedulePreflightWarning(
  sink: FrameWarningSink,
  warning: ElwoodWarningEvent | undefined,
): void {
  if (warning === undefined) return;
  const timer = setTimeout(() => deliverFrameWarnings(sink, [warning]), 0);
  timer.unref?.();
}
