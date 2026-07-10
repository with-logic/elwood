/**
 * Wires the Claude transcript watcher into the session's activity stream.
 * Implements PRD §5.4 (C-CLAUDE-15): committed assistant text and tool activity
 * come from the transcript(s), so an un-sent ghost-text suggestion never posts.
 */

import * as activity from "../core/activity.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import { ClaudeTranscriptWatcher } from "./transcript.ts";
import { dropWarning, readErrorWarning } from "./transcript-warnings.ts";

/** The session surface the watcher needs to persist and de-duplicate warnings. */
export type WarningSink = {
  recordWarnings(warnings: readonly ElwoodWarningEvent[]): void;
};

/**
 * Builds a transcript watcher that emits committed items and bounded diagnostics
 * (drops and contained fs errors). Diagnostics are routed through the session's
 * warning sink so they are de-duplicated, persisted into the session snapshot,
 * and emitted through the `warning` (and projected `activity`) contract rather
 * than as raw activity. The sink is resolved lazily because the session object
 * is constructed after the watcher (PRD §5.7). Until it exists, a diagnostic is
 * projected as `activity` only — a transient early-startup case.
 */
export function createTranscriptWatcher(
  elwoodSessionId: string,
  emitter: TypedEmitter,
  sink?: () => WarningSink | undefined,
): ClaudeTranscriptWatcher {
  const route = (warning: ElwoodWarningEvent) => {
    const target = sink?.();
    if (target) target.recordWarnings([warning]);
    else emitter.emit("activity", activity.activityFromWarning(warning));
  };
  return new ClaudeTranscriptWatcher(
    elwoodSessionId,
    (event) => emitter.emit("activity", activity.activityFromClaudeTranscript(event)),
    {
      onDrop: (notice) => route(dropWarning(notice)),
      onReadError: (notice) => route(readErrorWarning(notice)),
    },
  );
}

/** Turn-boundary hooks: a first observe here recovers the already-committed tail. */
const turnBoundaryHooks = new Set(["Stop", "SubagentStop"]);

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
  watcher: ClaudeTranscriptWatcher,
  event: { readonly [key: string]: unknown },
): void {
  const recoverTail = turnBoundaryHooks.has(event["hook_event_name"] as string);
  for (const key of ["transcript_path", "agent_transcript_path"]) {
    const path = event[key];
    if (typeof path === "string" && path.length > 0) watcher.observe(path, recoverTail);
  }
}
