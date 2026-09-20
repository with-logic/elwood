/** Separate update automation generations from retained input holds (PRD §5.5). */
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { codexComposerClearance } from "../screen/clearance.ts";
import { codexUpdatePromptVisible, isSafeUpdateContinuation } from "./recognition.ts";

/** Tracks update eligibility while retaining input until positive composer clearance. */
export class CodexUpdatePromptTracker {
  private active = false;
  private generation = 0;
  private holdingInput = false;
  private readonly clearsInput: TrustClearance;

  constructor(clearsInput: TrustClearance = codexComposerClearance) {
    this.clearsInput = clearsInput;
  }

  /** A replacement can cease being an update while still requiring human input. */
  get holdWithoutAppearance(): boolean {
    return this.holdingInput && !this.active;
  }

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
    } else if (!(this.active && isSafeUpdateContinuation(frameText))) {
      if (this.active) this.generation += 1;
      this.active = false;
    }
    this.holdingInput = this.active || (this.holdingInput && !this.clearsInput(frameText));
    return this.active;
  }

  /** Captures the current prompt generation so an async retry cannot enter a later dialog. */
  currentFramePredicate(): (frameText: string) => boolean {
    const generation = this.generation;
    return (frameText) =>
      this.active &&
      this.generation === generation &&
      (codexUpdatePromptVisible(frameText) || isSafeUpdateContinuation(frameText));
  }
}
