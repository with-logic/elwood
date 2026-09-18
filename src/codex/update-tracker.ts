/**
 * Tracks ONE appearance of the Codex in-TUI update screen across the frames it is split
 * over, and carries the first-party evidence that appearance has accumulated.
 * Implements PRD §5.5, C-CODEX-12 and C-CODEX-22.
 *
 * Split out of `update-prompt.ts` when the appearance gained evidence: that file owns the
 * single-frame RECOGNITION vocabulary (banner, safe-option pattern, option revalidation),
 * and this one owns the cross-frame LIFECYCLE built on top of it.
 */

import {
  appearanceBindingsHold,
  type CodexUpdateAppearanceEvidence,
  emptyUpdateEvidence,
  frameContinuesAppearance,
  withUpdateFrameEvidence,
} from "./update-evidence.ts";
import { codexUpdatePromptVisible, isSafeUpdateContinuation } from "./update-recognition.ts";

/**
 * Keeps a split prompt blocking until a frame with no update evidence clears it, and
 * carries each appearance's accumulated first-party evidence so a banner-less
 * continuation frame is checked against what THIS appearance actually showed rather
 * than against its own shape alone (C-CODEX-22; see `update-evidence.ts`).
 */
export class CodexUpdatePromptTracker {
  private active = false;
  private generation = 0;
  private evidence: CodexUpdateAppearanceEvidence = emptyUpdateEvidence();

  /** Identifies the current appearance; it changes whenever the update screen clears or appears. */
  get currentGeneration(): number {
    return this.generation;
  }

  /** True once a LATER appearance replaced `generation`; its own clear is only `generation + 1`. */
  hasLaterAppearance(generation: number): boolean {
    return this.generation > generation + 1;
  }

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
   * Whether a frame reassigns any option number this appearance already bound to a
   * different label. Applies to EVERY frame, first-party or not: a complete-looking
   * update screen that relabels a captured option is a replacement dialog, not a repaint.
   */
  private frameAgreesWithAppearance(frameText: string): boolean {
    return appearanceBindingsHold(this.evidence, frameText);
  }

  /**
   * A banner-less frame belongs to the active appearance only when it is safe-option
   * shaped AND consistent with the evidence that appearance has already accumulated.
   */
  private continuesCurrentAppearance(frameText: string): boolean {
    return (
      isSafeUpdateContinuation(frameText) && frameContinuesAppearance(this.evidence, frameText)
    );
  }
}
