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

import type { ElwoodWarningEvent } from "../types.ts";

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
 * A buffer-then-live warning sink for the STARTUP region. Warnings emitted BEFORE the
 * caller can subscribe (during the pre-return startup gate — MCP/transcript/preflight
 * diagnostics) are BUFFERED, then flushed on a deferred macrotask AFTER start resolves,
 * so a caller attaching a `warning` listener in the same turn it receives the session
 * still observes them (C-API-14) — WITHOUT restoring general late-subscriber replay.
 * Once opened, delivery is live pass-through. Every observed startup warning is
 * delivered: PRD §5.7/C-API-14 defines no overflow exception, and the buffer drains one
 * macrotask after start resolves, so it is inherently short-lived (the finite set of
 * startup diagnostics), not an unbounded queue — a silent cap could drop the guaranteed
 * `version_unparseable` warning. A macrotask (not a microtask) is required: a microtask
 * runs before the caller's post-`await` continuation, so it would fire into no listener.
 */
export function createStartupWarningGate(sink: FrameWarningSink): {
  readonly emitWarnings: (warnings: readonly ElwoodWarningEvent[]) => void;
  readonly openAfterReturn: () => void;
} {
  let open = false;
  const buffered: ElwoodWarningEvent[] = [];
  return {
    emitWarnings: (warnings) => {
      if (open) return deliverFrameWarnings(sink, warnings);
      buffered.push(...warnings);
    },
    openAfterReturn: () => {
      const timer = setTimeout(() => {
        open = true; // subsequent startup-frame warnings deliver live from here on
        const batch = buffered.splice(0);
        if (batch.length > 0) deliverFrameWarnings(sink, batch);
      }, 0);
      timer.unref?.();
    },
  };
}
