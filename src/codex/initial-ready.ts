/**
 * Codex initial-readiness marker: hook-backed, with a starvation deadline.
 * Implements PRD §5.3, C-API-19, and C-API-28.
 *
 * On a COLD start readiness fires from the `SessionStart` hook — Codex's
 * authoritative pre-input signal (`mark`) — and the rendered composer marker is NOT
 * used: it is a boot-time placeholder that paints ~1s before input is accepted, so
 * releasing the first queued message on it would swallow the message (C-API-28). On
 * RESUME the CLI does not re-fire `SessionStart`, but its input loop is live when the
 * composer paints, so `markReadyOnResumeComposer` releases readiness on the first
 * composer marker instead of waiting the deadline. `armDeadline` is the ultimate
 * fallback for both: if neither a hook nor (cold start) a composer signal arrives,
 * readiness still fires after a fixed deadline rather than never.
 *
 * The mechanism is shared with Claude (`InstructionsLoaded`); it lives in
 * `../runtime/initial-ready.ts` and is re-exported here for the Codex adapter.
 */

export {
  type InitialReady,
  initialReady,
  markReadyOnResumeComposer,
} from "../runtime/initial-ready.ts";
