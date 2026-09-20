/** Separate update automation generations from retained input holds (PRD §5.5). */
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { codexComposerClearance } from "../screen/clearance.ts";
import {
  appearanceBindingsHold,
  bannerContradictsAppearance,
  type CodexUpdateAppearanceEvidence,
  emptyUpdateEvidence,
  evidenceAllowsContinuation,
  withUpdateFrameEvidence,
} from "./evidence.ts";
import { codexUpdatePromptVisible, isSafeUpdateContinuation } from "./recognition.ts";

/** Tracks update eligibility while retaining input until positive composer clearance. */
export class CodexUpdatePromptTracker {
  private evidence: CodexUpdateAppearanceEvidence = emptyUpdateEvidence();
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
    const firstParty = codexUpdatePromptVisible(frameText);
    // Contradiction must be checked before first-party shape can authorize a replacement.
    if (
      this.active &&
      (bannerContradictsAppearance(this.evidence, frameText) ||
        !(this.evidence.overflowed || appearanceBindingsHold(this.evidence, frameText)))
    ) {
      this.generation += 1;
      this.active = false;
      this.evidence = emptyUpdateEvidence();
    }
    if (firstParty) {
      if (!this.active) {
        this.generation += 1;
        this.evidence = emptyUpdateEvidence();
      }
      this.active = true;
      this.evidence = withUpdateFrameEvidence(this.evidence, frameText, true);
    } else if (this.active && this.continuesCurrentAppearance(frameText)) {
      this.evidence = withUpdateFrameEvidence(this.evidence, frameText, false);
    } else if (this.active) {
      this.generation += 1;
      this.active = false;
      this.evidence = emptyUpdateEvidence();
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
      this.frameAgreesWithAppearance(frameText) &&
      (codexUpdatePromptVisible(frameText) || this.continuesCurrentAppearance(frameText));
  }
  private frameAgreesWithAppearance(frameText: string): boolean {
    return (
      appearanceBindingsHold(this.evidence, frameText) &&
      !bannerContradictsAppearance(this.evidence, frameText)
    );
  }

  private continuesCurrentAppearance(frameText: string): boolean {
    return (
      isSafeUpdateContinuation(frameText) && evidenceAllowsContinuation(this.evidence, frameText)
    );
  }
}
