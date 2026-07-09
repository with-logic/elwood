/**
 * Wires the Claude transcript watcher into the session's activity stream.
 * Implements PRD §5.4 (C-CLAUDE-15): committed assistant text and tool activity
 * come from the transcript, so an un-sent ghost-text suggestion never posts.
 */

import * as activity from "../core/activity.ts";
import type { TypedEmitter } from "../events/emitter.ts";
import { ClaudeTranscriptWatcher } from "./transcript.ts";

/** Builds a transcript watcher that emits committed items as activity events. */
export function createTranscriptWatcher(
  elwoodSessionId: string,
  emitter: TypedEmitter,
): ClaudeTranscriptWatcher {
  return new ClaudeTranscriptWatcher(elwoodSessionId, (event) =>
    emitter.emit("activity", activity.activityFromClaudeTranscript(event)),
  );
}

/**
 * Points the watcher at the path the hook payload carries, if any. Stop /
 * SubagentStop and most events include `transcript_path`; SubagentStop also
 * carries `agent_transcript_path`. The watcher no-ops when the path is unchanged.
 */
export function observeTranscript(
  watcher: ClaudeTranscriptWatcher,
  event: { readonly [key: string]: unknown },
): void {
  const path = event["transcript_path"] ?? event["agent_transcript_path"];
  if (typeof path === "string" && path.length > 0) watcher.observe(path);
}
