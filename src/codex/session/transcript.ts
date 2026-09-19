/**
 * Wires the bounded Codex transcript watcher to the session's warning sink.
 * The watcher is constructed BEFORE the session object, so a drop/read-error
 * notice observed early is BUFFERED and flushed through `emitWarnings` (which
 * emits it as a live `warning` + `activity`) once the sink exists — never dropped.
 * The caller MUST invoke `flushPendingWarnings` right after building the session so
 * a single early notice with no follow-up is not stranded. Warnings are live-only
 * (never persisted, counted, or replayed). Mirrors Claude's wiring. PRD §5.4/§5.7.
 */

import * as activity from "../../core/activity/index.ts";
import {
  createTranscriptWarningRouter,
  type TranscriptWarningSink,
} from "../../core/transcript/warning-router.ts";
import type { TypedEmitter } from "../../events/emitter.ts";
import {
  CodexTranscriptWatcher,
  codexDropWarning,
  codexPollStoppedWarning,
  codexReadErrorWarning,
} from "../transcript/index.ts";
import type { CodexEventMap } from "./types.ts";

/** A watcher plus the hook to flush any diagnostics buffered before the sink existed. */
type WiredCodexTranscriptWatcher = {
  readonly watcher: CodexTranscriptWatcher;
  readonly flushPendingWarnings: () => void;
  /** Drive `watcher.finish()` behind an error boundary, then run `afterFlush` in a
   * `finally` so a throwing final-flush listener never skips terminal:exit (C-LIFE-10). */
  readonly finishSafely: (afterFlush?: () => void) => void;
};

/**
 * Builds the transcript watcher, routing content-free drop/read-error notices to
 * the session's warning sink. Notices seen before `getSink()` resolves are held in
 * `pending`; both `route` and the returned `flushPendingWarnings` drain them, so a
 * lone early notice still surfaces once the caller flushes post-construction.
 */
export function createCodexTranscriptWatcher(
  elwoodSessionId: string,
  emitter: TypedEmitter<CodexEventMap>,
  getSink: () => TranscriptWarningSink | undefined,
): WiredCodexTranscriptWatcher {
  // The shared router buffers diagnostics observed BEFORE the sink exists (the watcher
  // is built first) and delivers each exactly once with clear-before-delivery + throw
  // containment (see core/transcript/warning-router).
  const { route, flushPendingWarnings } = createTranscriptWarningRouter(getSink);
  const watcher = new CodexTranscriptWatcher(
    elwoodSessionId,
    (event) => {
      // The INTERNAL activity projection must be delivered even if a PUBLIC `codex:transcript`
      // consumer throws. Turn-failure detection rides `activity` (C-API-57), so letting a
      // consumer's bug abort this sequence would silently restore the #19 empty-success bug for
      // a rejected turn. The listener error is still surfaced — it is rethrown after delivery,
      // never swallowed.
      let thrown: unknown;
      let failed = false;
      try {
        emitter.emit("codex:transcript", event);
      } catch (error) {
        thrown = error;
        failed = true;
      }
      emitter.emit("activity", activity.activityFromCodexTranscript(event));
      if (failed) throw thrown;
    },
    {
      onDrop: (notice) => route(codexDropWarning(notice)),
      onReadError: (notice) => route(codexReadErrorWarning(notice)),
      onPollError: (error) => route(codexPollStoppedWarning(elwoodSessionId, error)),
    },
  );
  // C-LIFE-10: drive the FINAL flush behind an error boundary, then run `afterFlush`
  // (terminal:exit emission, status, reap) in a `finally` so a throwing final-flush
  // listener can NEVER skip terminal:exit. A flush failure is contained and surfaced as
  // a bounded `transcript_poll_stopped` diagnostic phase-labelled `final_flush` (so lost
  // trailing shutdown activity is distinguishable from a live poll failure). Mirrors Claude.
  const finishSafely = (afterFlush: () => void = () => undefined) => {
    try {
      watcher.finish();
    } catch (error) {
      try {
        route(codexPollStoppedWarning(elwoodSessionId, error, "final_flush"));
      } catch {} // a diagnostic-listener bug must not block lifecycle completion
    } finally {
      afterFlush();
    }
  };
  return { watcher, flushPendingWarnings, finishSafely };
}
