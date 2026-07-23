/**
 * Rate-bounded, content-free accounting of Claude transcript observation problems.
 * Identical to Codex's accounting, so it re-exports the shared core trackers and
 * notice types under the adapter's names. Implements PRD §5.4 (C-CLAUDE-15). See
 * core/transcript/drops.
 */

export {
  type DropAccountingDelta,
  type DropCause,
  type DropSeed,
  DropTracker,
  type ReadErrorSeed,
  ReadErrorTracker,
  type TranscriptDropNotice,
  type TranscriptReadErrorNotice,
} from "../../core/transcript/drops.ts";
