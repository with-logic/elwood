/**
 * Public construction options for the Codex transcript watcher.
 * Implements PRD §7A/§5.4: the diagnostic notice handlers (bounded, content-free)
 * the watcher forwards for observation problems.
 */

import type {
  TranscriptDropNotice,
  TranscriptReadErrorNotice,
} from "../../core/transcript/drops.ts";

/** Notices the watcher forwards for observation problems (each fired live, once). */
export type CodexTranscriptNotices = {
  readonly onDrop?: (notice: TranscriptDropNotice) => void;
  readonly onReadError?: (notice: TranscriptReadErrorNotice) => void;
  /** A scan threw and the watcher stopped itself; carries the underlying error. */
  readonly onPollError?: (error: unknown) => void;
  /** Scan cadence override (defaults to the watcher default); tests use a short interval. */
  readonly scanIntervalMs?: number;
  /**
   * Monotonic clock for the PTY-exit drain's wall-clock slice. Tests inject a
   * controlled clock so a multi-chunk drain is deterministic rather than a race
   * against real time; production uses `Date.now`.
   */
  readonly now?: () => number;
};
