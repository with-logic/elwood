/**
 * Tracks ONE appearance of the Codex in-TUI update screen across the frames it is split
 * over, and carries the first-party evidence that appearance has accumulated.
 * Implements PRD §5.5, C-CODEX-12 and C-CODEX-22.
 *
 * Split out of `update-prompt.ts` when the appearance gained evidence: that file owns the
 * single-frame RECOGNITION vocabulary (banner, safe-option pattern, option revalidation),
 * and this one owns the cross-frame LIFECYCLE built on top of it.
 */

import { nonOptionText, numberedOptions } from "../core/terminal-options.ts";
import {
  type CodexUpdateAppearanceEvidence,
  emptyUpdateEvidence,
  frameContinuesAppearance,
  withUpdateFrameEvidence,
} from "./update-evidence.ts";
import { codexUpdatePromptVisible } from "./update-prompt.ts";

/**
 * A banner-less frame that offers a safe choice and nothing but options. Necessary for a
 * continuation but NOT sufficient — issue #50 showed an unrelated option-only prompt whose
 * every option is skip-shaped has exactly this shape. The appearance's own evidence
 * (`frameContinuesAppearance`) is what separates the two.
 */
export function isSafeUpdateContinuation(frameText: string): boolean {
  if (nonOptionText(frameText).trim() !== "") return false;
  return numberedOptions(frameText).some((option) =>
    /continue\s*without\s*updat|skip/i.test(option.label),
  );
}

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
    if (codexUpdatePromptVisible(frameText)) {
      // A first-party frame opens the appearance (or continues it) and is the evidence
      // every later banner-less frame is measured against.
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
    } else {
      if (this.active) this.generation += 1;
      this.active = false;
      this.evidence = emptyUpdateEvidence();
    }
    return this.active;
  }

  /** Captures the current prompt generation so an async retry cannot enter a later dialog. */
  currentFramePredicate(): (frameText: string) => boolean {
    const generation = this.generation;
    return (frameText) =>
      this.active &&
      this.generation === generation &&
      (codexUpdatePromptVisible(frameText) || this.continuesCurrentAppearance(frameText));
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
