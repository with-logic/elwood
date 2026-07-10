/**
 * Shared hook-backed initial-readiness marker with a starvation deadline.
 * Implements PRD §5.3, C-API-19, and C-API-28.
 *
 * Both adapters gate the first queued message on a pre-input readiness hook —
 * Claude's `InstructionsLoaded`, Codex's `SessionStart` — the CLI's authoritative
 * "initialized and accepting input" signal, fired via `mark`. Neither adapter
 * treats the rendered composer as a readiness signal: it paints as a boot-time
 * placeholder before input is accepted, and releasing the first queued message on
 * it swallows the message. `armDeadline` is the ONLY fallback: if the readiness
 * hook never arrives (a missing or failed hook bridge), readiness still fires
 * after a fixed deadline rather than starving the queue forever.
 */

export type InitialReady = {
  readonly cancel: () => void;
  readonly replay: () => void;
  readonly armDeadline: () => void;
  /** Fire readiness now (one-shot) — the pre-input readiness hook path. */
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
