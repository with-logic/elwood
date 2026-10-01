/** Tracks native update generations for bounded automation (PRD §5.5, C-CODEX-12). */
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { codexComposerClearance } from "../screen/clearance.ts";
import { type CodexUpdateFrame, CodexUpdateFrameClassifier } from "./classification.ts";
import {
  bannerContradictsAppearance,
  currentOptionBindingsMatch,
  emptyUpdateEvidence,
  retainedOptionLabelsAgree,
  retainedSafeOptionsPresent,
  withUpdateFrameEvidence,
} from "./evidence.ts";
import { updateScreenBanner } from "./layout.ts";
import { safeUpdateOption } from "./selection.ts";

/** Tracks update eligibility separately from the session’s retained input hold. */
export class CodexUpdatePromptTracker {
  private readonly frames = new CodexUpdateFrameClassifier();
  private evidence = emptyUpdateEvidence();
  private active = false;
  private generation = 0;
  private requiresBanner = false;
  private pendingClearance = false;

  private readonly clearance: TrustClearance;
  private readonly deferClearance: boolean;
  /** Live responders confirm after classification; standalone callers use the supplied clearance. */
  constructor(clearance: TrustClearance = codexComposerClearance, deferClearance = false) {
    this.clearance = clearance;
    this.deferClearance = deferClearance;
  }

  /** Identifies the current appearance; it changes when the screen clears, appears, or revokes an attempt. */
  get currentGeneration(): number {
    return this.generation;
  }

  /** Ordinary frames need no clearance parsing without a pending or revoked update. */
  get needsClearance(): boolean {
    return this.pendingClearance || this.requiresBanner;
  }

  /** A replacement revokes the attempt; its positive clear is only `generation + 1`. */
  hasSupersedingGeneration(generation: number): boolean {
    return this.generation > generation + 1;
  }

  appearanceChanged(frameText: string): boolean {
    const banner = updateScreenBanner.exec(frameText)?.[0].trim();
    const options = this.classify(frameText).options;
    return (
      this.active &&
      banner !== undefined &&
      !bannerContradictsAppearance({ observedBanner: banner }, frameText) &&
      (bannerContradictsAppearance(this.evidence, frameText) ||
        (options !== undefined &&
          safeUpdateOption(frameText, options) !== undefined &&
          !this.evidence.overflowed &&
          !(
            retainedOptionLabelsAgree(this.evidence, frameText, options) &&
            retainedSafeOptionsPresent(this.evidence, options)
          )))
    );
  }

  /** Fresh unambiguous evidence gives a revoked generation its own bounded grace. */
  renewsAttention(frameText: string): boolean {
    const frame = this.classify(frameText);
    return (
      frame.options !== undefined &&
      (!this.evidence.overflowed ||
        this.appearanceChanged(frameText) ||
        this.freshBoundedEvidence(frameText, frame)) &&
      (!this.requiresBanner || safeUpdateOption(frameText, frame.options) !== undefined) &&
      (this.appearanceChanged(frameText) || (this.requiresBanner && frame.hasBanner))
    );
  }

  /** Cache only this instance’s most recent exact viewport classification. */
  classify(frameText: string): CodexUpdateFrame {
    return this.frames.read(frameText);
  }

  observe(frameText: string): boolean {
    // Missing classification cannot lend a provisional clear to another frame.
    if (this.pendingClearance) this.observeClearance(false);
    if (this.appearanceChanged(frameText)) {
      this.generation += 1;
      this.active = false;
      this.evidence = emptyUpdateEvidence();
    }
    const frame = this.classify(frameText);
    const validEvidence = this.observeEvidence(frameText, frame);
    if (frame.visible && this.active && !this.requiresBanner && !validEvidence) {
      // Retire the attempt and its positive-clear edge; ambiguity is not success.
      this.generation += 2;
      this.requiresBanner = true;
    }
    if (frame.visible) {
      if (!this.active) this.generation += 1;
      if (
        validEvidence &&
        this.requiresBanner &&
        frame.hasBanner &&
        safeUpdateOption(frameText, frame.options)
      ) {
        this.generation += 1;
        this.requiresBanner = false;
      }
      this.active = true;
      if (!validEvidence) this.requiresBanner = true;
    } else {
      if (this.active) {
        this.generation += 1;
        this.requiresBanner = true;
        this.pendingClearance = true;
      }
      this.active = false;
      this.evidence = emptyUpdateEvidence();
      if (!this.deferClearance && this.needsClearance)
        this.observeClearance(this.clearance(frameText));
    }
    return this.active;
  }

  /** Only a current banner and validated block may authorize a write. */
  private observeEvidence(frameText: string, frame: CodexUpdateFrame): boolean {
    const firstParty = frame.hasBanner;
    if (this.freshBoundedEvidence(frameText, frame)) this.evidence = emptyUpdateEvidence();
    const priorBindingsAgree =
      frame.options !== undefined &&
      retainedOptionLabelsAgree(this.evidence, frameText, frame.options) &&
      retainedSafeOptionsPresent(this.evidence, frame.options);
    if (firstParty && frame.options !== undefined) {
      this.evidence = withUpdateFrameEvidence(this.evidence, frameText, true, frame.options);
    }
    if (frame.visible) {
      this.evidence = {
        ...this.evidence,
        observedBanner:
          this.evidence.observedBanner || (updateScreenBanner.exec(frameText)?.[0]?.trim() ?? ""),
      };
    }
    return (
      firstParty && frame.options !== undefined && !this.evidence.overflowed && priorBindingsAgree
    );
  }

  /** Only a fresh complete bounded block may retire an overflowed appearance. */
  private freshBoundedEvidence(frameText: string, frame: CodexUpdateFrame): boolean {
    return (
      this.requiresBanner &&
      frame.hasBanner &&
      frame.options !== undefined &&
      safeUpdateOption(frameText, frame.options) !== undefined &&
      !withUpdateFrameEvidence(emptyUpdateEvidence(), frameText, true, frame.options).overflowed
    );
  }

  /** Called after the current frame's live clearance and retained input hold are known. */
  observeClearance(cleared: boolean): void {
    if (this.pendingClearance) {
      if (!cleared) this.generation += 1;
      this.pendingClearance = false;
    }
    if (cleared && !this.active) this.requiresBanner = false;
  }

  /** Captures the current prompt generation so an async retry cannot enter a later dialog. */
  currentFramePredicate(): (frameText: string) => boolean {
    const generation = this.generation;
    return (frameText) => {
      if (!(this.active && !this.requiresBanner && this.generation === generation)) return false;
      if (bannerContradictsAppearance(this.evidence, frameText)) return false;
      const frame = this.classify(frameText);
      return (
        frame.hasBanner &&
        frame.options !== undefined &&
        retainedSafeOptionsPresent(this.evidence, frame.options) &&
        currentOptionBindingsMatch(this.evidence, frameText, frame.options)
      );
    };
  }
}
