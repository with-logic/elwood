/**
 * Builds bounded, content-free transcript diagnostic warnings.
 * Implements PRD §5.4 (C-CLAUDE-15): a dropped record or a contained filesystem
 * read error becomes a typed live `warning` carrying only a bounded cause/phase
 * label and an error code — never a count, byte magnitude, or raw transcript
 * content. These warnings are live-only (§5.7): each is emitted once when observed
 * and is never persisted, counted, or replayed.
 */

import {
  dropWarning as sharedDropWarning,
  readErrorWarning as sharedReadErrorWarning,
} from "../../core/transcript/warnings.ts";
import type { ElwoodWarningEvent } from "../../core/types.ts";
import { boundedErrorToken, isPollErrorReason } from "../../core/warning-reasons.ts";
import type { TranscriptDropNotice, TranscriptReadErrorNotice } from "./drops.ts";

/** The shared drop warning, tagged for Claude. */
export function dropWarning(notice: TranscriptDropNotice): ElwoodWarningEvent {
  return sharedDropWarning("claude", notice);
}

/** The shared read-error warning, tagged for Claude. */
export function readErrorWarning(notice: TranscriptReadErrorNotice): ElwoodWarningEvent {
  return sharedReadErrorWarning("claude", notice);
}

/** Which lifecycle phase surfaced a transcript-processing failure (§5.4). */
export type TranscriptFailurePhase = "poll" | "final_flush";

/** Phase-specific message so an operator can tell WHICH phase failed. */
const phaseMessage: Record<TranscriptFailurePhase, string> = {
  poll: "Transcript polling stopped after an unexpected error.",
  final_flush: "Transcript final flush at exit failed after an unexpected error.",
};

/**
 * A programming error escaped transcript processing; the watcher stopped (§5.4).
 * Phase-neutral by design: `phase` records WHERE it escaped — a live periodic poll
 * (`"poll"`) or the final flush at PTY exit (`"final_flush"`) — so a failed shutdown
 * flush (lost trailing activity) is distinguishable from a live-watcher poll failure
 * without a separate warning code. The public `transcript_poll_stopped` code is
 * kept (PRD-required), but the builder is named for BOTH phases it now handles.
 * This warning is live-only (emitted once when observed, never persisted), and the
 * escaping error can be a downstream activity-listener exception whose message
 * embeds raw transcript items (prompts, tool output, credentials). To honor the
 * content-free warning guarantee (§5.4/§8.3), only a bounded, allowlisted error
 * NAME/errno reaches the emitted fields — never `error.message` or `String(error)`.
 */
export function transcriptFailureWarning(
  elwoodSessionId: string,
  error: unknown,
  phase: TranscriptFailurePhase = "poll",
): ElwoodWarningEvent {
  // Only an allowlisted poll error-name/errno survives; any conversation-derived
  // string collapses to `UnknownError` via the shared bounded-token helper (§5.7).
  const reason = boundedErrorToken(error, isPollErrorReason);
  return {
    elwoodSessionId,
    agent: "claude",
    source: "terminal",
    code: "transcript_poll_stopped",
    severity: "warning",
    message: phaseMessage[phase],
    reason,
    phase,
    raw: `transcript_poll_stopped phase=${phase} reason=${reason}`,
  };
}
