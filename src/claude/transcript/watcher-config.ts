/**
 * Public construction options for the Claude transcript watcher.
 * Implements PRD §5.4 (C-CLAUDE-15): the diagnostic notice handlers (bounded,
 * content-free) and the resume seed that lets a watcher continue its running
 * drop/read-error counts from a persisted snapshot instead of restarting at 0.
 */

import type {
  DropSeed,
  ReadErrorSeed,
  TranscriptDropNotice,
  TranscriptReadErrorNotice,
} from "./drops.ts";

/** Notices the watcher forwards for observation problems (both rate-bounded). */
export type TranscriptNoticeHandlers = {
  readonly onDrop?: (notice: TranscriptDropNotice) => void;
  readonly onReadError?: (notice: TranscriptReadErrorNotice) => void;
  /** A programming error escaped the timer poll; the watcher has stopped. */
  readonly onPollError?: (error: unknown) => void;
  /** Poll cadence override (defaults to the watcher default); tests use a short interval. */
  readonly pollIntervalMs?: number;
};

/**
 * Prior running totals recovered from persisted warnings so a resumed watcher's
 * counts never restart at 0 — a same-code warning's persisted count must never go
 * backwards after resume (C-CLAUDE-15).
 */
export type TranscriptWatcherSeed = {
  readonly drops?: DropSeed;
  readonly readErrors?: ReadErrorSeed;
};
