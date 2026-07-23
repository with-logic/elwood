/**
 * Public construction options for the Codex transcript watcher.
 * Implements PRD §7A/§5.4: the diagnostic notice handlers (bounded, content-free)
 * the watcher forwards for observation problems.
 */

import type { CodexDropNotice, CodexReadErrorNotice } from "./drops.ts";

/** Notices the watcher forwards for observation problems (each fired live, once). */
export type CodexTranscriptNotices = {
  readonly onDrop?: (notice: CodexDropNotice) => void;
  readonly onReadError?: (notice: CodexReadErrorNotice) => void;
  /** A scan threw and the watcher stopped itself; carries the underlying error. */
  readonly onPollError?: (error: unknown) => void;
  /** Scan cadence override (defaults to the watcher default); tests use a short interval. */
  readonly scanIntervalMs?: number;
};
