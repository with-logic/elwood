/**
 * Shared hook-backed initial-readiness marker with a starvation deadline.
 * Implements PRD §5.3/§9.4, C-API-19, and C-API-28.
 *
 * On a COLD start both adapters gate the first queued message on a pre-input
 * readiness hook — Claude's `InstructionsLoaded`, Codex's `SessionStart` — the CLI's
 * authoritative "initialized and accepting input" signal, fired via `mark`. The
 * rendered composer is NOT a readiness signal on cold start: it paints as a boot
 * placeholder before input is accepted, so releasing the first queued message on it
 * would swallow the message. On RESUME the input loop is live when the composer paints,
 * so `markReadyOnResumeComposer` releases readiness on the first composer marker
 * (verified accepted, not swallowed) — UNLESS a blocking dialog is on screen, whose
 * option caret is byte-identical to the composer marker. The hooks differ on resume:
 * Codex does NOT re-fire `SessionStart` (so the composer is the fast signal), while
 * Claude's `InstructionsLoaded` DOES re-fire — so a resumed Claude is a hook/composer
 * race, whichever arrives first (readiness is idempotent). `armDeadline` is the ultimate
 * fallback for both start and resume so a missing readiness signal never starves the
 * queue forever.
 */

export type InitialReady = {
  /** Permanently cancel readiness, including frames drained after process exit. */
  readonly cancel: () => void;
  readonly replay: () => void;
  readonly armDeadline: () => void;
  /** Fire readiness now (one-shot) — the pre-input readiness hook path. */
  readonly mark: () => void;
  /**
   * Re-attempt a readiness mark that a hook/deadline requested while a blocking
   * dialog was on screen. Call per rendered frame with the frame's blocking fact:
   * once the dialog clears, the deferred readiness fires so the queue is never
   * drained INTO the dialog and is never permanently starved BY it (C-API-28).
   */
  readonly retryWhenUnblocked: (blockingVisible: boolean) => void;
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

export function initialReady(
  callback: () => void,
  maxWaitMs = 10_000,
  isBlocked: () => boolean = () => false,
): InitialReady {
  let ready = false;
  let cancelled = false;
  let deferredByBlock = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const mark = () => {
    if (ready || cancelled) return;
    // A blocking dialog is on screen (it may have rendered while still `starting`,
    // so it never latched `blocked`): do NOT release the queue into it. Remember the
    // request and re-fire it from `retryWhenUnblocked` once the dialog clears — never
    // latch here, so readiness is neither drained into the dialog nor starved by it.
    if (isBlocked()) {
      deferredByBlock = true;
      return;
    }
    deferredByBlock = false;
    // Latch AFTER the callback returns, so if it throws (a throwing status/activity
    // listener) readiness is NOT consumed and a later hook/deadline/frame retries —
    // a failed transition must never permanently starve the queue (C-API-28).
    callback();
    ready = true;
  };
  return {
    cancel: () => {
      cancelled = true;
      if (deadline) clearTimeout(deadline);
    },
    mark,
    retryWhenUnblocked: (blockingVisible) => {
      if (!ready && deferredByBlock && !blockingVisible) mark();
    },
    replay: () => void (!cancelled && ready && callback()),
    // Arms on the first frame regardless of hook arrival, so a missing or failed
    // readiness hook cannot starve readiness forever. The deadline's mark is contained
    // (a throwing callback on a timer would otherwise be an uncaught exception); if it
    // fails, `ready` stays false so a later hook or composer frame still retries.
    armDeadline: () => {
      if (cancelled) return;
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
