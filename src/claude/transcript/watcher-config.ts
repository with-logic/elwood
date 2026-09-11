/**
 * Public construction options for the Claude transcript watcher.
 * Implements PRD §5.4 (C-CLAUDE-15): the diagnostic notice handlers (bounded,
 * content-free) the watcher forwards for observation problems.
 */

import type { TranscriptDropNotice, TranscriptReadErrorNotice } from "./drops.ts";

/** Notices the watcher forwards for observation problems (each fired live, once). */
export type TranscriptNoticeHandlers = {
  readonly onDrop?: (notice: TranscriptDropNotice) => void;
  readonly onReadError?: (notice: TranscriptReadErrorNotice) => void;
  /** A programming error escaped the timer poll; the watcher has stopped. */
  readonly onPollError?: (error: unknown) => void;
  /** Poll cadence override (defaults to the watcher default); tests use a short interval. */
  readonly pollIntervalMs?: number;
  /**
   * Monotonic clock for the PTY-exit drain's wall-clock slice. Tests inject a
   * controlled clock so a multi-chunk drain is deterministic rather than a race
   * against real time; production uses `Date.now`.
   */
  readonly now?: () => number;
};
