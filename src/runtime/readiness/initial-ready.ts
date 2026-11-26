/**
 * Shared hook-backed readiness evidence checks and a diagnostic backstop.
 * Implements PRD §5.3/§9.4, C-API-19, C-API-28, and the deadline of C-ATTN-09.
 *
 * On a COLD start both adapters gate the first queued message on a pre-input
 * readiness hook — Claude's `InstructionsLoaded`, Codex's `SessionStart` — the CLI's
 * authoritative "initialized and accepting input" signal, fired via `mark`. The
 * rendered composer is NOT a readiness signal on cold start: it paints as a boot
 * placeholder before input is accepted, so releasing the first queued message on it
 * would swallow the message. On RESUME the conversation already exists, so
 * `markReadyOnResumeComposer` releases readiness on the first CONFIGURED composer
 * instead of the deadline, subject to `createReadinessGate`'s composite hold:
 * human/automation gates and their working or partial clearance frames. A composer
 * marker alone is not that evidence: a resumed CLI paints a loading placeholder with
 * the marker, and a startup dialog can select a row with it (Codex 0.171.0's update
 * offer draws `› 1. Update now`). The hooks differ on resume:
 * Codex does NOT re-fire `SessionStart` (so the composer is the fast signal), while
 * Claude's `InstructionsLoaded` DOES re-fire — so a resumed Claude is a hook/composer
 * race, whichever arrives first (readiness is idempotent). A deadline provides
 * fallback readiness, subject to configured-composer evidence when supplied. Its
 * backstop reports missing evidence while retaining queued input.
 */

import { runContained } from "../../core/contained.ts";

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
 * visible, no blocking dialog is on screen, AND the adapter verified it as a configured
 * session's composer (`configured`, the deadline's evidence). Ordinary Codex `›` and
 * Claude `❯` composers share their dialog's option caret; Codex `ultra` uses the
 * distinct `»`. A dialog frame must NOT latch readiness, or a queued message's Enter
 * could approve it; readiness waits for the composite hold owned by
 * `createReadinessGate` to release on verified idle. An unrecognized screen is no
 * dialog to the fact table, so only the configured composer keeps input off it, and a
 * caller without that evidence passes a predicate that never confirms.
 * Cold start (`resumed: false`) never fires here, so the
 * composer stays an unsafe signal there (C-API-28).
 */
export function markReadyOnResumeComposer(
  ready: Pick<InitialReady, "mark">,
  resumed: boolean,
  facts: ComposerReadyFacts,
  configured: () => boolean,
  readinessHeld = false,
): void {
  if (
    resumed &&
    facts.composer_visible &&
    !facts.blocking_prompt_visible &&
    !readinessHeld &&
    configured()
  )
    ready.mark();
}

export const initialBackstopMs = 60_000;

export type ConfiguredComposerEvidence = {
  /** The latest frame shows a configured session's composer outside any blocking dialog. */
  readonly shown: () => boolean;
  readonly onBackstop: () => void;
  /** The deadline passed without readiness (C-ATTN-09). */
  readonly onDeadline?: () => void;
  readonly backstopMs?: number;
};

/**
 * Deadline marks require configured-composer evidence when supplied. The backstop
 * warns once if that evidence is missing, retaining input until a hook or a later
 * configured frame. Elapsed time alone cannot authorize writing into a dialog.
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
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let backstop: ReturnType<typeof setTimeout> | undefined;
  /**
   * Timer marks are contained. A mark whose callback throws leaves `ready` false; a later
   * readiness hook, or for the deadline the backstop, retries it.
   */
  const markFromTimer = () => {
    try {
      awaitingComposer = !isComposerConfigured();
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
    // Latch AFTER the callback returns, so if it throws (a throwing status/activity
    // listener) readiness is NOT consumed and a later hook/deadline/frame retries —
    // a failed transition must never permanently starve the queue (C-API-28).
    callback();
    ready = true;
    clearTimeout(deadline);
    clearTimeout(backstop);
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
      // A hold-deferred mark retries when the hold releases. A deadline waiting on
      // composer evidence retries when the adapter verifies that composer.
      if (deferredByHold || (awaitingComposer && isComposerConfigured())) mark();
    },
    replay: () => void (!cancelled && ready && callback()),
    // Timer readiness still requires the adapter's input evidence; the backstop
    // diagnoses missing evidence without authorizing input. Observer throws stay
    // contained so later hooks or configured frames can retry.
    armDeadline: () => {
      if (cancelled || ready) return;
      deadline ??= setTimeout(() => {
        markFromTimer();
        // Observer failure must not stop the timer path, as below.
        if (!ready) runContained(() => composer?.onDeadline?.());
      }, initialDeadlineMs);
      backstop ??= setTimeout(() => {
        markFromTimer();
        try {
          if (!ready && composer && !composer.shown()) composer.onBackstop();
        } catch {
          // Observer failure must not release unsafe input.
        }
      }, composer?.backstopMs ?? initialBackstopMs);
    },
  };
}
