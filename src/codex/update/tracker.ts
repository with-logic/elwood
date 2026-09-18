/**
 * Tracks ONE appearance of the Codex in-TUI update screen across the frames it is split
 * over, and carries the first-party evidence that appearance has accumulated.
 * Implements PRD §5.5, C-CODEX-12 and C-CODEX-22.
 *
 * Recognition of a single frame lives in `recognition.ts`; this file owns the cross-frame
 * LIFECYCLE built on top of it, and `index.ts` owns the write path.
 */

import { numberedOptions } from "../../core/terminal-options.ts";
import {
  appearanceBindingsHold,
  bannerContradictsAppearance,
  type CodexUpdateAppearanceEvidence,
  emptyUpdateEvidence,
  evidenceAllowsContinuation,
  withUpdateFrameEvidence,
} from "./evidence.ts";
import { codexUpdatePromptVisible, hasContinuationShape } from "./recognition.ts";

/**
 * Whether a frame still presents an answerable dialog — any numbered option block. Used
 * only to decide whether an EXISTING hold may be released, never to start one: a frame
 * that has moved on to the composer or ordinary output carries no options and positively
 * clears the hold.
 */
function frameShowsDialog(frameText: string): boolean {
  return numberedOptions(frameText).length > 0;
}

/**
 * Keeps a split prompt blocking until a frame with no update evidence clears it, and
 * carries each appearance's accumulated first-party evidence so a banner-less
 * continuation frame is checked against what THIS appearance actually showed rather
 * than against its own shape alone (C-CODEX-22; see `evidence.ts`).
 *
 * The tracker answers TWO different questions, and they fail safe in OPPOSITE
 * directions — which is why they cannot share one boolean (round 2 of #59):
 *
 * - `observe` / `automationEligible`: may Elwood WRITE the skip digit? A contradicted
 *   appearance must answer NO, because the digit was chosen for a different dialog.
 * - `dialogVisible`: must queued caller/persona input keep being HELD? The very same
 *   contradicted frame must answer YES, because a prompt is still on screen — it is
 *   simply one Elwood may not answer. Releasing there would paste and press Enter into
 *   an unrelated human prompt, which is the same "advanced without consent" outcome the
 *   digit would have caused, reached by another path.
 *
 * So the hold is only ever released by something POSITIVE: a frame with no dialog on it
 * at all. It is never released as a side effect of ending an appearance.
 */
export class CodexUpdatePromptTracker {
  private active = false;
  private generation = 0;
  private evidence: CodexUpdateAppearanceEvidence = emptyUpdateEvidence();
  /** Held while ANY dialog we recognized is still on screen, answerable by us or not. */
  private holdingInput = false;

  /** Identifies the current appearance; it changes whenever the update screen clears or appears. */
  get currentGeneration(): number {
    return this.generation;
  }

  /** True once a LATER appearance replaced `generation`; its own clear is only `generation + 1`. */
  hasLaterAppearance(generation: number): boolean {
    return this.generation > generation + 1;
  }

  /**
   * Whether a recognized dialog is still on screen, so queued input must stay held.
   * Supplied to the session's `blocking_prompt_visible` fact INSTEAD of `observe`: a
   * frame Elwood must not automate is still a frame a human owns (C-API-56, C-CODEX-22).
   */
  dialogVisible(frameText: string): boolean {
    this.observe(frameText);
    return this.holdingInput;
  }

  /** Whether the skip digit may be written for the frame last observed. */
  observe(frameText: string): boolean {
    const firstParty = codexUpdatePromptVisible(frameText);
    // A frame that CONTRADICTS this appearance's captured bindings is a different dialog,
    // however complete it looks. Checking that BEFORE the first-party branch is the whole
    // point: a replacement such as `1. Skip backup` / `2. Update now` is first-party
    // SHAPED, so an early accept on shape alone would let it inherit the running
    // attempt's authorization and take the digit bound to the old `1` (round 1, #59).
    if (this.active && !this.frameAgreesWithAppearance(frameText)) {
      // End the contradicted appearance. A first-party replacement immediately opens its
      // OWN appearance below, so it is still blocking — but on a new generation, with
      // fresh evidence, which strands every predicate captured on the old one.
      this.generation += 1;
      this.active = false;
      this.evidence = emptyUpdateEvidence();
    }
    if (firstParty) {
      // A first-party frame opens the appearance (or continues it) and is the evidence
      // every later frame of that appearance is measured against.
      if (!this.active) {
        this.generation += 1;
        this.evidence = emptyUpdateEvidence();
      }
      this.active = true;
      this.evidence = withUpdateFrameEvidence(this.evidence, frameText, true);
    } else if (this.active && this.continuesCurrentAppearance(frameText)) {
      // A banner-less safe-option repaint of the SAME appearance stays latched, and
      // folds its own rows in so a third frame is checked against all of them.
      this.evidence = withUpdateFrameEvidence(this.evidence, frameText, false);
    } else if (this.active) {
      this.generation += 1;
      this.active = false;
      this.evidence = emptyUpdateEvidence();
    }
    // The hold is INDEPENDENT of automation eligibility. An active appearance always
    // holds. Once held, the hold PERSISTS across any frame that still presents a dialog —
    // including the contradicted replacement, a prompt we may not answer but a human
    // still owns — and is released only by a frame that positively shows none. Elwood
    // never STARTS a hold for a dialog it did not recognize; it only refuses to drop one
    // it is already carrying while a prompt is still up (round 2 of #59).
    this.holdingInput = this.active || (this.holdingInput && frameShowsDialog(frameText));
    return this.active;
  }

  /**
   * Captures the current prompt generation so an async retry cannot enter a later dialog.
   * Retry eligibility uses the SAME agreement check as `observe`, so a frame that
   * contradicts the captured bindings can never authorize a write even in the window
   * before the next `observe` sees it.
   */
  currentFramePredicate(): (frameText: string) => boolean {
    const generation = this.generation;
    return (frameText) =>
      this.active &&
      this.generation === generation &&
      this.frameAgreesWithAppearance(frameText) &&
      (codexUpdatePromptVisible(frameText) || this.continuesCurrentAppearance(frameText));
  }

  /**
   * `true` when the frame AGREES with this appearance: every option number it shows still
   * carries the label the appearance bound it to, so nothing was reassigned. `false` means
   * a captured number came back under a different label. Applies to EVERY frame,
   * first-party or not — a complete-looking update screen that relabels a captured option
   * is a replacement dialog, not a repaint.
   */
  private frameAgreesWithAppearance(frameText: string): boolean {
    // A different VERSION pair is a different appearance even when the options match
    // exactly, so the banner is checked alongside the option bindings (round 2 of #59).
    return (
      appearanceBindingsHold(this.evidence, frameText) &&
      !bannerContradictsAppearance(this.evidence, frameText)
    );
  }

  /**
   * A banner-less frame belongs to the active appearance only when it is safe-option
   * shaped AND consistent with the evidence that appearance has already accumulated.
   */
  private continuesCurrentAppearance(frameText: string): boolean {
    return hasContinuationShape(frameText) && evidenceAllowsContinuation(this.evidence, frameText);
  }
}
