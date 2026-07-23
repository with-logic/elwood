/**
 * Wires the bounded Codex transcript watcher to the session's warning sink.
 * The watcher is constructed BEFORE the session object, so a drop/read-error
 * notice observed early is BUFFERED and flushed through `recordWarnings` once the
 * sink exists — never dropped or emitted activity-only (which would neither persist
 * nor replay). The caller MUST invoke `flushPendingWarnings` right after building
 * the session so a single early notice with no follow-up is not stranded. A resume
 * seed recovers prior running totals so counts never restart at 0. Mirrors Claude's
 * wiring. Implements PRD §5.4/§5.7.
 */

import * as activity from "../core/activity.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import type { CodexEventMap } from "./session-types.ts";
import type { CodexTranscriptSeed } from "./transcript/watcher-config.ts";
import {
  CodexTranscriptWatcher,
  codexDropWarning,
  codexPollStoppedWarning,
  codexReadErrorWarning,
} from "./transcript.ts";

/** The session-side sink that persists, de-duplicates, and replays warnings. */
export type CodexWarningSink = {
  readonly recordWarnings: (warnings: readonly ElwoodWarningEvent[]) => void;
};

/** A watcher plus the hook to flush any diagnostics buffered before the sink existed. */
export type WiredCodexTranscriptWatcher = {
  readonly watcher: CodexTranscriptWatcher;
  readonly flushPendingWarnings: () => void;
  /** Drive `watcher.finish()` behind an error boundary, then run `afterFlush` in a
   * `finally` so a throwing final-flush listener never skips terminal:exit (C-LIFE-10). */
  readonly finishSafely: (afterFlush?: () => void) => void;
};

/**
 * Recovers the prior running drop/read-error totals from a resumed session's
 * persisted warnings so the watcher continues from the snapshot instead of
 * restarting at 0 — otherwise the first post-resume failure would REPLACE a
 * same-code warning's stored count (e.g. 60 → 1), erasing history (PRD §5.4).
 */
export function codexTranscriptSeedFromWarnings(
  warnings: readonly ElwoodWarningEvent[],
): CodexTranscriptSeed {
  let drops: CodexTranscriptSeed["drops"];
  let readErrors: CodexTranscriptSeed["readErrors"];
  for (const warning of warnings) {
    if (warning.code === "transcript_records_dropped")
      drops = { droppedCount: warning.droppedCount, droppedBytes: warning.droppedBytes };
    else if (warning.code === "transcript_read_error")
      readErrors = { errorCount: warning.errorCount };
  }
  return {
    ...(drops === undefined ? {} : { drops }),
    ...(readErrors === undefined ? {} : { readErrors }),
  };
}

/**
 * Builds the transcript watcher, routing content-free drop/read-error notices to
 * the session's warning sink. Notices seen before `getSink()` resolves are held in
 * `pending`; both `route` and the returned `flushPendingWarnings` drain them, so a
 * lone early notice still persists once the caller flushes post-construction.
 */
export function createCodexTranscriptWatcher(
  elwoodSessionId: string,
  emitter: TypedEmitter<CodexEventMap>,
  getSink: () => CodexWarningSink | undefined,
  seed: CodexTranscriptSeed = {},
): WiredCodexTranscriptWatcher {
  const pending: ElwoodWarningEvent[] = [];
  const flushPendingWarnings = () => {
    const sink = getSink();
    if (!sink || pending.length === 0) return;
    // Hand the sink a COPY and clear `pending` only AFTER it returns: a throwing
    // recordWarnings must not lose the buffered notices — they stay queued to retry.
    sink.recordWarnings([...pending]);
    pending.length = 0;
  };
  const route = (warning: ElwoodWarningEvent) => {
    // COALESCE by code, then attempt delivery. Transcript diagnostics are running
    // aggregates (a newer `transcript_records_dropped`/`transcript_read_error`/
    // `transcript_poll_stopped` supersedes the older of the same code), so `pending`
    // holds at most one entry per code — a persistently failing sink cannot grow it
    // unboundedly (which would make each retry copy a growing list: quadratic). If the
    // sink is absent OR throws, the coalesced notice stays queued and is retried on
    // the next scan/flush — never lost, never escaping into the poll loop (§5.4).
    const at = pending.findIndex((w) => w.code === warning.code);
    if (at >= 0) pending[at] = warning;
    else pending.push(warning);
    try {
      flushPendingWarnings();
    } catch {
      // Contained: the notice is still queued (flushPendingWarnings clears only on
      // success), so a later scan re-delivers it and the watcher stays live.
    }
  };
  const watcher = new CodexTranscriptWatcher(
    elwoodSessionId,
    (event) => {
      emitter.emit("codex:transcript", event);
      emitter.emit("activity", activity.activityFromCodexTranscript(event));
    },
    {
      onDrop: (notice) => route(codexDropWarning(notice)),
      onReadError: (notice) => route(codexReadErrorWarning(notice)),
      onPollError: (error) => route(codexPollStoppedWarning(elwoodSessionId, error)),
    },
    seed,
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
