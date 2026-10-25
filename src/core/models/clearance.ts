/**
 * How long a model dialog must stay gone before input may follow it (PRD §5.3, C-API-55).
 * Shared by the input holds and by a picker operation's own close wait.
 */

/**
 * Consecutive positive clearance READINGS that prove a dialog is gone rather than
 * mid-repaint. A reading is one look at the latest completed frame. It need not be a new
 * frame: idle CLIs do not repaint, so the hold counts readings spaced in time
 * (`clearReadingGapMs`), not rendered-frame callbacks.
 *
 * Matches `quietFramesToSettle` in `core/turn-state.ts`, deliberately. That value IS
 * measured: Codex's resume replay repaints in bursts with brief 1-frame quiet gaps, and 5
 * clears them with margin (docs/cli-behavior.md, C-TURN-03). Picker repaints are the same
 * class of problem — a dialog redrawing between stages is briefly unrecognizable — and we
 * have NOT measured their gap length, so there is no evidence for a smaller number.
 *
 * The failure directions are not symmetric, which settles it. Too high only delays
 * releasing the input hold. Too low releases queued input into a repainting picker, where
 * Enter applies the highlighted model — the exact bug class this file exists to prevent.
 * Absent a measurement, take the conservative measured precedent.
 *
 * This governs every input hold (`runtime/session/picker-hold.ts`), which is unbounded and
 * only observes, so a longer streak costs nothing but a little latency, and an operation's
 * close wait (`close-wait.ts`). Failure cleanup uses a shorter one on purpose: see
 * `cleanupClearReadings` in `runtime/session/picker-cleanup.ts`.
 */
export const clearReadings = 5;

/**
 * The least time between two clearance readings that both count toward `clearReadings`.
 * Below the 50 ms queued-write retry (`unsafeWriteRetryMs`), so each retry of a waiting
 * writer counts, while readings bunched into one instant, or a burst of repaints, count
 * once: a release takes four gaps (160 ms or more). What a reading must show differs by
 * consumer: an input hold (`picker-hold.ts`) needs positive native-composer clearance, while
 * a successful operation's close wait (`close-wait.ts`) needs only that the bottom-most
 * region is not its dialog, since the composer is never clear during a turn.
 */
export const clearReadingGapMs = 40;
