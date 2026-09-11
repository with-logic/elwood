/**
 * Public entry point for live Codex transcript observation.
 * Implements PRD §7A and §5.4 (C-API-12): re-exports the bounded transcript watcher
 * and its item summarizer from the `transcript/` module directory, keeping this
 * import path stable for callers (`src/index.ts`, `core/activity-*`, tests).
 */

export { summarizeTranscriptItem, toolOutputText } from "./summary.ts";
export type { CodexTranscriptEvent, CodexTranscriptSummary } from "./types.ts";
export {
  codexDropWarning,
  codexPollStoppedWarning,
  codexReadErrorWarning,
} from "./warnings.ts";
export type {
  CodexDropNotice,
  CodexReadErrorNotice,
  CodexTranscriptNotices,
} from "./watcher.ts";
export { CodexTranscriptWatcher } from "./watcher.ts";
