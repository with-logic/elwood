/** Tracks native update generations for bounded automation (PRD §5.5, C-CODEX-12). */
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { codexComposerClearance } from "../screen/clearance.ts";
import { type CodexUpdateFrame, classifyCodexUpdateFrame } from "./recognition.ts";

/** Tracks update eligibility separately from the session’s retained input hold. */
export class CodexUpdatePromptTracker {
  private parsed: { readonly text: string; readonly frame: CodexUpdateFrame } | undefined;
  private active = false;
  private continuationEligible = false;
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

  /** A replacement or ambiguity retires the attempt; its own clear is only `generation + 1`. */
  hasSupersedingGeneration(generation: number): boolean {
    return this.generation > generation + 1;
  }

  /** One exact viewport per tracker; a replacement drops the previous private text. */
  classify(frameText: string): CodexUpdateFrame {
    if (this.parsed?.text !== frameText) {
      this.parsed = { text: frameText, frame: classifyCodexUpdateFrame(frameText) };
    }
    return this.parsed.frame;
  }

  observe(frameText: string): boolean {
    // Missing classification cannot lend a provisional clear to another frame.
    if (this.pendingClearance) this.observeClearance(false);
    const frame = this.classify(frameText);
    const validLayout = frame.options !== undefined;
    const visible = frame.visible;
    if (visible && this.active && this.continuationEligible && !validLayout) {
      // Retire both the attempt and its clearance edge: ambiguity is a replacement,
      // not the successful clear (one generation step) owned by the old attempt.
      this.generation += 2;
      this.continuationEligible = false;
      this.requiresBanner = true;
    }
    if (visible) {
      if (!this.active) this.generation += 1;
      if (validLayout && this.requiresBanner && frame.hasBanner) {
        this.generation += 1;
        this.requiresBanner = false;
      }
      this.active = true;
      if (!validLayout) this.requiresBanner = true;
      this.continuationEligible = validLayout && !this.requiresBanner;
    } else if (!(this.active && this.continuationEligible && frame.continuation)) {
      this.clearAppearance(frameText);
    }
    return this.active;
  }

  private clearAppearance(frameText: string): void {
    if (this.active) {
      this.generation += 1;
      this.requiresBanner = true;
      this.pendingClearance = true;
    }
    this.active = false;
    if (!this.deferClearance) this.observeClearance(this.clearance(frameText));
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
      if (!(this.active && this.continuationEligible && this.generation === generation))
        return false;
      const frame = this.classify(frameText);
      return frame.options !== undefined && (frame.visible || frame.continuation);
    };
  }
}
