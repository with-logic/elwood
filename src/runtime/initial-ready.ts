/**
 * Shared hook-backed initial-readiness marker with a starvation deadline.
 * Implements PRD §5.3, C-API-19, and C-API-28.
 *
 * On a COLD start both adapters gate the first queued message on a pre-input
 * readiness hook — Claude's `InstructionsLoaded`, Codex's `SessionStart` — the CLI's
 * authoritative "initialized and accepting input" signal, fired via `mark`. The
 * rendered composer is NOT a readiness signal on cold start: it paints as a boot
 * placeholder before input is accepted, so releasing the first queued message on it
 * would swallow the message. On RESUME the CLI reattaches to an existing conversation
 * without re-firing that hook, and its input loop is live when the composer paints,
 * so `markReadyOnResumeComposer` releases readiness on the first composer marker
 * (verified accepted, not swallowed) — UNLESS a blocking dialog is on screen, whose
 * option caret is byte-identical to the composer marker. `armDeadline` is the ultimate
 * fallback for both start and resume so a missing readiness signal never starves the
 * queue forever.
 */

export type InitialReady = {
  readonly cancel: () => void;
  readonly replay: () => void;
  readonly armDeadline: () => void;
  /** Fire readiness now (one-shot) — the pre-input readiness hook path. */
  readonly mark: () => void;
};

/** The rendered-frame facts the resume-composer readiness path inspects. */
export type ComposerReadyFacts = {
  readonly composer_visible: boolean;
  readonly blocking_prompt_visible: boolean;
};

/**
 * On RESUME, mark readiness on the first genuine composer frame: the composer is
 * visible AND no blocking dialog is on screen. The dialog's option caret (`›`/`❯`) is
 * byte-identical to the composer marker, so a dialog frame must NOT latch readiness —
 * otherwise a draining queued message's Enter could approve the dialog; readiness waits
 * for the dialog to clear. Cold start (`resumed: false`) never fires here, so the
 * composer stays an unsafe signal there (C-API-28).
 */
export function markReadyOnResumeComposer(
  ready: Pick<InitialReady, "mark">,
  resumed: boolean,
  facts: ComposerReadyFacts,
): void {
  if (resumed && facts.composer_visible && !facts.blocking_prompt_visible) ready.mark();
}

export function initialReady(callback: () => void, maxWaitMs = 10_000): InitialReady {
  let ready = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const mark = () => {
    if (ready) return;
    // Latch AFTER the callback returns, so if it throws (a failed durable status write
    // or a throwing listener) readiness is NOT consumed and a later hook/deadline/frame
    // retries — a failed transition must never permanently starve the queue (C-API-28).
    callback();
    ready = true;
  };
  return {
    cancel: () => {
      if (deadline) clearTimeout(deadline);
    },
    mark,
    replay: () => void (ready && callback()),
    // Arms on the first frame regardless of hook arrival, so a missing or failed
    // readiness hook cannot starve readiness forever. The deadline's mark is contained
    // (a throwing callback on a timer would otherwise be an uncaught exception); if it
    // fails, `ready` stays false so a later hook or composer frame still retries.
    armDeadline: () => {
      deadline ??= setTimeout(() => {
        try {
          mark();
        } catch {
          // Retried by a subsequent readiness hook or rendered composer frame.
        }
      }, maxWaitMs);
    },
  };
}
