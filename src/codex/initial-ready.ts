/**
 * Codex initial-readiness marker: hook-backed, with a starvation deadline.
 * Implements PRD §5.3, C-API-19, and C-API-28.
 *
 * Readiness fires from the `SessionStart` hook — Codex's authoritative pre-input
 * signal (`mark`). The rendered composer marker is NOT used: it is a boot-time
 * placeholder that paints ~1s before input is accepted, and releasing the first
 * queued message on it swallows the message (C-API-28). `armDeadline` is the
 * only fallback: if the readiness hook never arrives (missing/failed hook
 * bridge), readiness still fires after a fixed deadline rather than never.
 *
 * The mechanism is shared with Claude (`InstructionsLoaded`); it lives in
 * `../runtime/initial-ready.ts` and is re-exported here for the Codex adapter.
 */

export { type InitialReady, initialReady } from "../runtime/initial-ready.ts";
