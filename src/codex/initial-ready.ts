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
 */

export type InitialReady = {
  readonly cancel: () => void;
  readonly replay: () => void;
  readonly armDeadline: () => void;
  /** Fire readiness now (one-shot) — the `SessionStart` hook path. */
  readonly mark: () => void;
};

export function initialReady(callback: () => void, maxWaitMs = 10_000): InitialReady {
  let ready = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const mark = () => {
    if (ready) return;
    ready = true;
    callback();
  };
  return {
    cancel: () => {
      if (deadline) clearTimeout(deadline);
    },
    mark,
    replay: () => void (ready && callback()),
    // Arms on the first frame regardless of hook arrival, so a missing or failed
    // readiness hook cannot starve readiness forever.
    armDeadline: () => {
      deadline ??= setTimeout(mark, maxWaitMs);
    },
  };
}
