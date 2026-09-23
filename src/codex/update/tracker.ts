/** Tracks native update generations for bounded automation (PRD §5.5, C-CODEX-12). */
import { updateDialogOptions } from "./layout.ts";
import { codexUpdatePromptVisible, isSafeUpdateContinuation } from "./recognition.ts";

/** Keeps a split prompt blocking until a frame with no update evidence clears it. */
export class CodexUpdatePromptTracker {
  private active = false;
  private continuationEligible = false;
  private generation = 0;

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
      if (!this.active) this.generation += 1;
      this.active = true;
      this.continuationEligible = updateDialogOptions(frameText) !== undefined;
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
