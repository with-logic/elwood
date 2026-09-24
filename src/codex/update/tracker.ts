/** Tracks native update generations for bounded automation (PRD §5.5, C-CODEX-12). */
import { codexComposerClearance } from "../screen/clearance.ts";
import {
  codexUpdatePromptVisible,
  isSafeUpdateContinuation,
  updateScreenBanner,
} from "./recognition.ts";

/** Keeps a split prompt blocking until a frame with no update evidence clears it. */
export class CodexUpdatePromptTracker {
  private active = false;
  private generation = 0;
  private requiresBanner = false;

  /** Identifies the current appearance; it changes when the screen clears, appears, or revokes an attempt. */
  get currentGeneration(): number {
    return this.generation;
  }

  /** A replacement revokes the attempt; its positive clear is only `generation + 1`. */
  hasSupersedingGeneration(generation: number): boolean {
    return this.generation > generation + 1;
  }

  observe(frameText: string): boolean {
    if (codexUpdatePromptVisible(frameText)) {
      if (!this.active) this.generation += 1;
      if (this.requiresBanner && updateScreenBanner.test(frameText)) {
        this.generation += 1;
        this.requiresBanner = false;
      }
      this.active = true;
    } else if (!(this.active && !this.requiresBanner && isSafeUpdateContinuation(frameText))) {
      if (this.active) {
        const cleared = codexComposerClearance(frameText);
        this.generation += cleared ? 1 : 2;
        if (!cleared) this.requiresBanner = true;
      }
      this.active = false;
    }
    return this.active;
  }

  /** Captures the current prompt generation so an async retry cannot enter a later dialog. */
  currentFramePredicate(): (frameText: string) => boolean {
    const generation = this.generation;
    return (frameText) =>
      this.active &&
      !this.requiresBanner &&
      this.generation === generation &&
      (codexUpdatePromptVisible(frameText) || isSafeUpdateContinuation(frameText));
  }
}
