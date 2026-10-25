/**
 * Shared hook-backed initial-readiness marker with a two-stage starvation deadline.
 * Implements PRD §5.3/§9.4, C-API-19, and C-API-28.
 *
 * On a COLD start both adapters gate the first queued message on a pre-input
 * readiness hook — Claude's `InstructionsLoaded`, Codex's `SessionStart` — the CLI's
 * authoritative "initialized and accepting input" signal, fired via `mark`. The
 * rendered composer is NOT a readiness signal on cold start: it paints as a boot
 * placeholder before input is accepted, so releasing the first queued message on it
 * would swallow the message. On RESUME the input loop is live when the composer paints,
 * so `markReadyOnResumeComposer` releases readiness on the first composer marker
 * (verified accepted, not swallowed), subject to `createReadinessGate`'s composite
 * hold: human/automation gates and their working or partial clearance frames. The hooks differ on resume:
 * Codex does NOT re-fire `SessionStart` (so the composer is the fast signal), while
 * Claude's `InstructionsLoaded` DOES re-fire — so a resumed Claude is a hook/composer
 * race, whichever arrives first (readiness is idempotent). `armDeadline` is the ultimate
 * fallback for both start and resume so a missing readiness signal never starves the
 * queue forever: its deadline marks onto a configured composer, and its backstop marks
 * regardless.
 */

export type InitialReady = {
  /** Permanently cancel readiness, including frames drained after process exit. */
  readonly cancel: () => void;
  readonly replay: () => void;
  readonly armDeadline: () => void;
  /** Fire readiness now (one-shot) — the pre-input readiness hook path. */
  readonly mark: () => void;
  /**
   * Per rendered frame: re-attempt a hook/deadline mark the composite readiness hold
   * deferred, once it releases (a dialog must clear to a nonblocking idle composer), or
   * a deadline mark still waiting for a configured composer (C-API-28).
   */
  readonly retryWhenReleased: (readinessHeld: boolean) => void;
};

/** The rendered-frame facts the resume-composer readiness path inspects. */
export type ComposerReadyFacts = {
  readonly composer_visible: boolean;
  /** Present on rendered readings; work must not release deferred initial readiness. */
  readonly working_visible?: boolean;
  readonly blocking_prompt_visible: boolean;
};

/**
 * On RESUME, mark readiness on the first genuine composer frame: the composer is
 * visible AND no blocking dialog is on screen. The dialog's option caret (`›`/`❯`) is
 * byte-identical to the composer marker, so a dialog frame must NOT latch readiness —
 * otherwise a draining queued message's Enter could approve the dialog; readiness waits
 * for the composite hold owned by `createReadinessGate` to release on verified idle.
 * Cold start (`resumed: false`) never fires here, so the
 * composer stays an unsafe signal there (C-API-28).
 */
export function markReadyOnResumeComposer(
  ready: Pick<InitialReady, "mark">,
  resumed: boolean,
  facts: ComposerReadyFacts,
  readinessHeld = false,
): void {
  if (resumed && facts.composer_visible && !facts.blocking_prompt_visible && !readinessHeld)
    ready.mark();
}

/**
 * Twice the longest measured Codex 0.164 trust-gate delay (30.6 s after first output,
 * docs/cli-behavior.md): readiness without a configured composer this long after the
 * first frame is no longer racing a late gate (C-API-28).
 */
export const initialBackstopMs = 60_000;

/** An adapter's evidence that a rendered composer belongs to a configured session. */
export type ConfiguredComposerEvidence = {
  /** The latest frame shows a configured session's composer outside any blocking dialog. */
  readonly shown: () => boolean;
  /** Readiness was released after the backstop without that composer on screen. */
  readonly onBackstopRelease: () => void;
  readonly backstopMs?: number;
};

/**
 * With `composer` evidence, the initial deadline marks only onto a frame showing a
 * configured session's composer: a CLI that has not configured its session is still
 * booting, and under load can paint a trust gate after the deadline, so an earlier mark
 * would drain the queue into the boot screen or that gate. A deadline that expires first
 * waits for that frame, and the backstop after the first frame marks anyway, so an
 * unrecognized composer delays readiness but never starves it. A release after the
 * backstop without that composer is reported once through `onBackstopRelease`, so a host
 * can tell it from ordinary readiness (C-API-28).
 */
export function initialReady(
  callback: () => void,
  initialDeadlineMs = 10_000,
  isReadinessHeld: () => boolean = () => false,
  composer?: ConfiguredComposerEvidence,
): InitialReady {
  const isComposerConfigured = () => composer === undefined || composer.shown();
  let ready = false;
  let cancelled = false;
  let deferredByHold = false;
  let awaitingComposer = false;
  let backstopFired = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let backstop: ReturnType<typeof setTimeout> | undefined;
  /**
   * Timer marks are contained. A mark whose callback throws leaves `ready` false; a later
   * readiness hook, or for the deadline the backstop, retries it.
   */
  const markFromTimer = (composerRequired: boolean) => {
    try {
      awaitingComposer = composerRequired && !isComposerConfigured();
      if (!awaitingComposer) mark();
    } catch {
      // Retried by a later readiness hook or timer, as above.
    }
  };
  const mark = () => {
    if (ready || cancelled) return;
    // createReadinessGate owns the composite hold: human/automation gates and
    // their working or partial clearance frames, including startup. Remember the
    // request and re-fire it from retryWhenReleased once that hold releases — never
    // latch here, so readiness is neither drained into the dialog nor starved by it.
    if (isReadinessHeld()) {
      deferredByHold = true;
      return;
    }
    deferredByHold = false;
    const withoutComposer = composer !== undefined && backstopFired && !composer.shown();
    // Latch AFTER the callback returns, so if it throws (a throwing status/activity
    // listener) readiness is NOT consumed and a later hook/deadline/frame retries —
    // a failed transition must never permanently starve the queue (C-API-28).
    callback();
    ready = true;
    clearTimeout(deadline);
    clearTimeout(backstop);
    try {
      if (withoutComposer) composer.onBackstopRelease();
    } catch {
      // A failing warning sink must not undo or block the readiness just released.
    }
  };
  return {
    cancel: () => {
      cancelled = true;
      clearTimeout(deadline);
      clearTimeout(backstop);
    },
    mark,
    retryWhenReleased: (readinessHeld) => {
      if (ready || readinessHeld) return;
      // A hold-deferred mark retries once the hold releases; a deadline that expired
      // before the configured composer retries on the first frame showing it, even
      // while work is on screen.
      if (deferredByHold || (awaitingComposer && isComposerConfigured())) mark();
    },
    replay: () => void (!cancelled && ready && callback()),
    // Arms on the first frame regardless of hook arrival, so a missing or failed
    // readiness hook cannot starve readiness forever. Timer marks are contained (a
    // throwing callback on a timer would otherwise be an uncaught exception).
    armDeadline: () => {
      if (cancelled || ready) return;
      deadline ??= setTimeout(() => markFromTimer(true), initialDeadlineMs);
      backstop ??= setTimeout(() => {
        backstopFired = true;
        markFromTimer(false);
      }, composer?.backstopMs ?? initialBackstopMs);
    },
  };
}
