/**
 * Public construction options for the Codex transcript watcher.
 * Implements PRD §7A/§5.4: the diagnostic notice handlers (bounded, content-free)
 * and the resume seed that lets a watcher continue its running drop/read-error
 * counts from a persisted snapshot instead of restarting at 0.
 */

import type { CodexDropNotice, CodexReadErrorNotice, DropSeed, ReadErrorSeed } from "./drops.ts";

/** Notices the watcher forwards for observation problems (both rate-bounded). */
export type CodexTranscriptNotices = {
  readonly onDrop?: (notice: CodexDropNotice) => void;
  readonly onReadError?: (notice: CodexReadErrorNotice) => void;
  /** Scan cadence override (defaults to the watcher default); tests use a short interval. */
  readonly scanIntervalMs?: number;
};

/**
 * Prior running totals recovered from persisted warnings so a resumed watcher's
 * counts never restart at 0 — a same-code warning's persisted count must never go
 * backwards after resume.
 */
export type CodexTranscriptSeed = {
  readonly drops?: DropSeed;
  readonly readErrors?: ReadErrorSeed;
};
