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
  /** Include deferred startup-warning fan-out in the exit-order barrier. */
  readonly duringDelivery: (work: () => void) => void;
  readonly flushPendingWarnings: () => void;
  /** Drive `watcher.finish()` behind an error boundary, then run `afterFlush` in a
   * `finally` so an internal final-flush error never skips terminal:exit (C-LIFE-10). */
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
  const warnings = createTranscriptWarningRouter(getSink);
  let deliveryDepth = 0;
  function duringDelivery(work: () => void): void {
    deliveryDepth += 1;
    try {
      work();
    } finally {
      deliveryDepth -= 1;
    }
  }
  const route = (warning: Parameters<typeof warnings.route>[0]) =>
    duringDelivery(() => warnings.route(warning));
  const flushPendingWarnings = () => duringDelivery(warnings.flushPendingWarnings);
  const reported = new Set<"codex:transcript" | "activity">();
  // TypedEmitter fans out to all listeners before rethrowing. Contain each channel
  // separately so one consumer cannot suppress the projection or stop later polls.
  function deliver<K extends "codex:transcript" | "activity">(channel: K, event: CodexEventMap[K]) {
    try {
      emitter.emit(channel, event);
    } catch {
      if (reported.has(channel)) return;
      reported.add(channel);
      // Run warning callbacks after the current scan/flush. A callback may stop
      // the session synchronously, so it must not interrupt paired record delivery.
      queueMicrotask(() =>
        route({
          elwoodSessionId,
          agent: "codex",
          source: "terminal",
          code: "transcript_listener_error",
          severity: "warning",
          message: "Codex transcript listener failed; remaining transcript delivery continues.",
          channel,
          raw: `transcript_listener_error channel=${channel}`,
        }),
      );
    }
  }
  const watcher = new CodexTranscriptWatcher(
    elwoodSessionId,
    (event) =>
      duringDelivery(() => {
        deliver("codex:transcript", event);
        deliver("activity", activity.activityFromCodexTranscript(event));
      }),
    {
      onDrop: (notice) => route(codexDropWarning(notice)),
      onReadError: (notice) => route(codexReadErrorWarning(notice)),
      onPollError: (error) => route(codexPollStoppedWarning(elwoodSessionId, error)),
    },
  );
  // C-LIFE-10: drive the FINAL flush behind an error boundary, then run `afterFlush`
  // (terminal:exit emission, status, reap) in a `finally` so an internal drain
  // error cannot skip terminal:exit. A flush failure is contained and surfaced as
  // a bounded `transcript_poll_stopped` diagnostic phase-labelled `final_flush` (so lost
  // trailing shutdown activity is distinguishable from a live poll failure). Mirrors Claude.
  const finishSafely = (afterFlush: () => void = () => undefined) => {
    if (deliveryDepth > 0) {
      // A listener can synchronously stop the PTY. Let the bounded scan deliver
      // every record it already read before finalizing the watcher and session.
      queueMicrotask(() => finishSafely(afterFlush));
      return;
    }
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
  return { watcher, duringDelivery, flushPendingWarnings, finishSafely };
}
