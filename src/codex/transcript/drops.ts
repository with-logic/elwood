/**
 * Content-free, live-only accounting of Codex transcript observation problems.
 * Identical to Claude's accounting, so it re-exports the shared core trackers and
 * notice types under the adapter's names. Implements PRD §7A/§5.4. See
 * core/transcript/drops.
 */

export {
  type DropCause,
  DropReporter as CodexDropReporter,
  ReadErrorReporter as CodexReadErrorReporter,
  type TranscriptDropNotice as CodexDropNotice,
  type TranscriptReadErrorNotice as CodexReadErrorNotice,
} from "../../core/transcript/drops.ts";
