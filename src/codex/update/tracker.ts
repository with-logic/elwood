/** Tracks native update generations for bounded automation (PRD §5.5, C-CODEX-12). */
import { updateDialogOptions, updateScreenBanner } from "./layout.ts";
import { codexUpdatePromptVisible, isSafeUpdateContinuation } from "./recognition.ts";

/** Keeps a split prompt blocking until a frame with no update evidence clears it. */
export class CodexUpdatePromptTracker {
  private active = false;
  private continuationEligible = false;
  private generation = 0;
  private requiresBanner = false;

  /** Identifies the current appearance; it changes when the screen clears, appears, or revokes an attempt. */
  get currentGeneration(): number {
    return this.generation;
  }

  /** A replacement or ambiguity retires the attempt; its own clear is only `generation + 1`. */
  hasLaterAppearance(generation: number): boolean {
    return this.generation > generation + 1;
  }

  observe(frameText: string): boolean {
    const validLayout = updateDialogOptions(frameText) !== undefined;
    const visible = codexUpdatePromptVisible(frameText);
    if (visible && this.active && this.continuationEligible && !validLayout) {
      // Retire both the attempt and its clearance edge: ambiguity is a replacement,
      // not the successful clear (one generation step) owned by the old attempt.
      this.generation += 2;
      this.continuationEligible = false;
      this.requiresBanner = true;
    }
    if (visible) {
      if (!this.active) this.generation += 1;
      if (validLayout && this.requiresBanner && updateScreenBanner.test(frameText)) {
        this.generation += 1;
        this.requiresBanner = false;
      }
      this.active = true;
      if (!validLayout) this.requiresBanner = true;
      this.continuationEligible = validLayout && !this.requiresBanner;
    } else if (!(this.active && this.continuationEligible && isSafeUpdateContinuation(frameText))) {
      if (this.active) this.generation += 1;
      this.active = false;
    }
    return this.active;
  }

  /** Captures the current prompt generation so an async retry cannot enter a later dialog. */
  currentFramePredicate(): (frameText: string) => boolean {
    const generation = this.generation;
    return (frameText) =>
      this.active &&
      this.continuationEligible &&
      updateDialogOptions(frameText) !== undefined &&
      this.generation === generation &&
      (codexUpdatePromptVisible(frameText) || isSafeUpdateContinuation(frameText));
  }
}
