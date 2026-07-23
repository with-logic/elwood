/**
 * Shared live-only transcript-warning router for both adapters.
 * Implements PRD §5.4/§5.7 (C-CLAUDE-15, C-CODEX-20): a transcript diagnostic
 * (drop, contained fs error, poll-stop) observed BEFORE the session sink exists is
 * BUFFERED and flushed once the sink resolves — never silently dropped. Delivery
 * clears the pending buffer FIRST, so a warning is delivered exactly once: a throwing
 * warning/activity listener is contained and the warning is dropped, not retried — a
 * human's terminal does not re-show a banner. `pending` is bounded to the pre-sink
 * startup window; it can never grow under a persistently-throwing listener.
 */

import type { ElwoodWarningEvent } from "../types.ts";

/** The session-side sink that emits a batch as live `warning` + `activity` events. */
export type TranscriptWarningSink = {
  readonly emitWarnings: (warnings: readonly ElwoodWarningEvent[]) => void;
};

/** The router: route a live diagnostic and flush any pre-sink buffered diagnostics. */
export type TranscriptWarningRouter = {
  /** Buffer a diagnostic and attempt immediate delivery (contained). */
  readonly route: (warning: ElwoodWarningEvent) => void;
  /** Flush diagnostics buffered before the sink existed; call once it does. */
  readonly flushPendingWarnings: () => void;
};

/**
 * Builds the router. The sink is resolved lazily because the session object is
 * constructed AFTER the watcher, so early diagnostics are held until it exists.
 */
export function createTranscriptWarningRouter(
  getSink: () => TranscriptWarningSink | undefined,
): TranscriptWarningRouter {
  const pending: ElwoodWarningEvent[] = [];
  const flushPendingWarnings = () => {
    const sink = getSink();
    if (!sink || pending.length === 0) return;
    const batch = pending.splice(0); // clear FIRST — delivered once, never retried
    sink.emitWarnings(batch);
  };
  const route = (warning: ElwoodWarningEvent) => {
    pending.push(warning);
    try {
      flushPendingWarnings();
    } catch {
      // Contained: a throwing warning listener must not stop the poll loop (§5.4).
      // The warning was already removed from `pending`, so it is dropped, not
      // retried — the watcher stays live.
    }
  };
  return { route, flushPendingWarnings };
}
