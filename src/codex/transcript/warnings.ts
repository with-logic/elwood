/**
 * Builds bounded, content-free Codex transcript diagnostic warnings.
 * Implements PRD §7A/§5.4: a dropped record or a contained filesystem read error
 * becomes a typed live `warning` carrying only a bounded cause/phase label and an
 * error code — never a count, byte magnitude, or raw transcript content. These are
 * live-only (§5.7): each is emitted once when observed, never persisted, counted,
 * or replayed. Mirrors Claude's transcript/warnings builders so both adapters
 * surface identical, shared `transcript_records_dropped` / `transcript_read_error`
 * warnings.
 */

import type {
  TranscriptDropNotice,
  TranscriptReadErrorNotice,
} from "../../core/transcript/drops.ts";
import { dropWarning, readErrorWarning } from "../../core/transcript/warnings.ts";
import type { ElwoodWarningEvent } from "../../core/types.ts";
import {
  boundedErrorToken,
  isPollErrorReason,
  type PollPhase,
} from "../../core/warnings/reasons.ts";

/** The shared drop warning, tagged for Codex. */
export function codexDropWarning(notice: TranscriptDropNotice): ElwoodWarningEvent {
  return dropWarning("codex", notice);
}

/** The shared read-error warning, tagged for Codex. */
export function codexReadErrorWarning(notice: TranscriptReadErrorNotice): ElwoodWarningEvent {
  return readErrorWarning("codex", notice);
}

/**
 * A scan threw and the watcher stopped itself. The escaping error can be a
 * downstream activity-listener exception whose message embeds raw transcript
 * content, so only a bounded, allowlisted error NAME/errno reaches the emitted
 * `reason` — never `error.message` (content-free guarantee, §5.4/§8.3).
 */
export function codexPollStoppedWarning(
  elwoodSessionId: string,
  error: unknown,
  phase: PollPhase = "poll",
): ElwoodWarningEvent {
  const reason = boundedErrorToken(error, isPollErrorReason);
  return {
    elwoodSessionId,
    agent: "codex",
    source: "terminal",
    code: "transcript_poll_stopped",
    severity: "warning",
    // `phase` distinguishes a live poll failure from the FINAL flush at exit, so lost
    // trailing shutdown activity is diagnosable without a distinct warning code (§9.2).
    message:
      "Codex transcript polling stopped after a scan error; live activity may be incomplete.",
    reason,
    phase,
    raw: `transcript_poll_stopped reason=${reason} phase=${phase}`,
  };
}
