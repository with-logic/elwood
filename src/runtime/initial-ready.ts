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

/**
 * On RESUME, the CLI reattaches to an existing conversation and does NOT re-fire its
 * pre-input readiness hook, so waiting for the hook means always waiting out the full
 * deadline. But a resumed CLI's input loop IS live when the composer paints (verified:
 * a message submitted then is accepted, not swallowed like the cold-start placeholder),
 * so the first visible composer marks readiness. Cold start passes `resumed: false` and
 * this never fires — the composer stays an unsafe signal there (C-API-28).
 */
export function markReadyOnResumeComposer(
  ready: Pick<InitialReady, "mark">,
  resumed: boolean,
  composerVisible: boolean,
): void {
  if (resumed && composerVisible) ready.mark();
}

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
