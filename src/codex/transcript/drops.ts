/**
 * Content-free, live-only reporting of Codex transcript observation problems.
 * Identical to Claude's, so it re-exports the shared core reporters (DropReporter /
 * ReadErrorReporter) and notice types under the adapter's names. Each problem emits
 * one live, count-free warning; nothing is accumulated. Implements PRD §7A/§5.4. See
 * core/transcript/drops.
 */

export {
  type DropCause,
  DropReporter as CodexDropReporter,
  ReadErrorReporter as CodexReadErrorReporter,
  type TranscriptDropNotice as CodexDropNotice,
  type TranscriptReadErrorNotice as CodexReadErrorNotice,
} from "../../core/transcript/drops.ts";
