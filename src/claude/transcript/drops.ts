/**
 * Content-free, live-only reporting of Claude transcript observation problems.
 * Identical to Codex's, so it re-exports the shared core reporters (DropReporter /
 * ReadErrorReporter) and notice types under the adapter's names. Each problem emits
 * one live, count-free warning; nothing is accumulated. Implements PRD §5.4
 * (C-CLAUDE-15). See core/transcript/drops.
 */

export {
  type DropCause,
  DropReporter,
  ReadErrorReporter,
  type TranscriptDropNotice,
  type TranscriptReadErrorNotice,
} from "../../core/transcript/drops.ts";
