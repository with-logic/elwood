/**
 * Wires the Claude transcript watcher into the session's activity stream.
 * Implements PRD §5.4 (C-CLAUDE-15): committed assistant text and tool activity
 * come from the transcript(s), so an un-sent ghost-text suggestion never posts.
 */

import * as activity from "../core/activity.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import { ClaudeTranscriptWatcher, type TranscriptWatcherSeed } from "./transcript/index.ts";
import { dropWarning, pollErrorWarning, readErrorWarning } from "./transcript/warnings.ts";

/** The session surface the watcher needs to persist and de-duplicate warnings. */
export type WarningSink = {
  recordWarnings(warnings: readonly ElwoodWarningEvent[]): void;
};

/** The narrow emitter surface the transcript wiring needs (activity only). */
export type TranscriptActivityEmitter = {
  emit(event: "activity", payload: activity.ElwoodActivityEvent): void;
};

/** A watcher plus a hook to flush any early-buffered warnings once the sink exists. */
export type WiredTranscriptWatcher = {
  readonly watcher: ClaudeTranscriptWatcher;
  /** Flush warnings buffered before the session sink existed; call once it does. */
  readonly flushPendingWarnings: () => void;
  /**
   * Drive `watcher.finish()` behind an error boundary (PRD §5.3 C-LIFE-10): the
   * final transcript flush emits deltas through activity listeners, and a throwing
   * listener must NOT abort the PTY-exit callback before it emits `terminal:exit`,
   * persists terminal status, and reaps. `afterFlush` runs in a `finally` so those
   * steps always execute. The flush itself is bounded (a shared watcher-wide chunk
   * budget plus a small wall-clock slice, §9.2), so it returns to the event loop
   * promptly rather than looping over a hundreds-of-MiB backlog. A flush failure is
   * contained and routed as a bounded, content-free `transcript_poll_stopped`
   * diagnostic carrying `phase: "final_flush"` (so lost trailing shutdown activity
   * is distinguishable from a live poll failure); a throwing diagnostic listener is
   * swallowed so it can't block lifecycle completion.
   */
  readonly finishSafely: (afterFlush?: () => void) => void;
};

/**
 * Recovers the prior running drop/read-error totals from a resumed session's
 * persisted warnings so the watcher continues counting from the snapshot instead
 * of restarting at 0. Without this, the first post-resume failure would REPLACE a
 * same-code warning's stored count (e.g. 60 → 1), erasing history and violating
 * the running-count semantics (C-CLAUDE-15).
 */
export function transcriptSeedFromWarnings(
  warnings: readonly ElwoodWarningEvent[],
): TranscriptWatcherSeed {
  let drops: TranscriptWatcherSeed["drops"];
  let readErrors: TranscriptWatcherSeed["readErrors"];
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
 * Builds a transcript watcher that emits committed items and bounded diagnostics
 * (drops, contained fs errors, and a poll-error stop). Diagnostics are routed
 * through the session's warning sink so they are de-duplicated, persisted into
 * the session snapshot, and emitted through the `warning`/`activity` contract.
 * The sink is resolved lazily because the session object is constructed after the
 * watcher (PRD §5.7). A diagnostic observed BEFORE the sink exists is BUFFERED
 * and flushed through `recordWarnings` once it does — never silently emitted as
 * activity-only (which would neither persist nor replay).
 */
export function createTranscriptWatcher(
  elwoodSessionId: string,
  emitter: TranscriptActivityEmitter,
  sink?: () => WarningSink | undefined,
  seed: TranscriptWatcherSeed = {},
): WiredTranscriptWatcher {
  const pending: ElwoodWarningEvent[] = [];
  const flushPendingWarnings = () => {
    const target = sink?.();
    if (target && pending.length > 0) target.recordWarnings(pending.splice(0));
  };
  const route = (warning: ElwoodWarningEvent) => {
    const target = sink?.();
    if (!target) {
      pending.push(warning); // sink not ready yet: hold until it is, don't drop
      return;
    }
    flushPendingWarnings();
    target.recordWarnings([warning]);
  };
  const watcher = new ClaudeTranscriptWatcher(
    elwoodSessionId,
    (event) => emitter.emit("activity", activity.activityFromClaudeTranscript(event)),
    {
      onDrop: (notice) => route(dropWarning(notice)),
      onReadError: (notice) => route(readErrorWarning(notice)),
      onPollError: (error) => route(pollErrorWarning(elwoodSessionId, error)),
    },
    seed,
  );
  // C-LIFE-10: flush trailing committed items behind an error boundary, then run
  // `afterFlush` (terminal:exit emission, status, reap) in a `finally` so a throwing
  // flush listener can never abort lifecycle completion. A flush failure is contained
  // and surfaced as a bounded diagnostic; a throwing diagnostic route is swallowed.
  const noop = () => undefined;
  const finishSafely = (afterFlush: () => void = noop) => {
    try {
      watcher.finish();
    } catch (error) {
      try {
        // A failed FINAL flush at exit is phase-labelled so an operator can tell
        // lost trailing shutdown activity from a live poll failure (MAJOR: phase).
        route(pollErrorWarning(elwoodSessionId, error, "final_flush"));
      } catch {} // a diagnostic-listener bug must not block lifecycle completion
    } finally {
      afterFlush();
    }
  };
  return { watcher, flushPendingWarnings, finishSafely };
}

/** Turn-boundary hooks: a first observe here recovers the already-committed tail. */
const turnBoundaryHooks = new Set(["Stop", "SubagentStop"]);

/** The narrow watcher surface observeTranscript drives (observe + retire only). */
export type ObservableTranscript = Pick<ClaudeTranscriptWatcher, "observe" | "retire">;

/**
 * Points the watcher at every transcript path the hook payload carries. A
 * `SubagentStop` event has both a main `transcript_path` and a required
 * `agent_transcript_path`; both must be observed (PRD §5.4). The watcher keeps
 * an independent cursor per path and no-ops on an already-observed path.
 *
 * Backward tail recovery runs only when the FIRST observe of a path lands on a
 * turn-boundary hook (`Stop`/`SubagentStop`) — the case where a just-committed
 * turn would otherwise be missed. On `SessionStart`/resume the first observe
 * baselines at EOF with no recovery, so a resumed session never republishes the
 * prior conversation's final assistant/tool turn (PRD §5.4, C-CLAUDE-15).
 */
export function observeTranscript(
  watcher: ObservableTranscript,
  event: { readonly [key: string]: unknown },
): void {
  const hook = event["hook_event_name"] as string;
  const recoverTail = turnBoundaryHooks.has(hook);
  for (const key of ["transcript_path", "agent_transcript_path"]) {
    const path = event[key];
    if (typeof path !== "string" || path.length === 0) continue;
    watcher.observe(path, recoverTail);
    // A SubagentStop's agent transcript is a one-shot input: flush it now and
    // retire it from active polling so a long session with many subagents does
    // not accumulate cursors statted twice a second forever (PRD §5.4). The flush
    // shares the watcher-wide terminal budget and a wall-clock slice, so it cannot
    // stall the hook-dispatch path with a hundreds-of-MiB synchronous loop (§9.2).
    if (hook === "SubagentStop" && key === "agent_transcript_path") watcher.retire(path);
  }
}
