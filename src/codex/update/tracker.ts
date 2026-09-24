/** Tracks native update generations for bounded automation (PRD §5.5, C-CODEX-12). */
import type { TrustClearance } from "../../core/trust/clearance.ts";
import { codexComposerClearance } from "../screen/clearance.ts";
import {
  codexUpdatePromptVisible,
  isSafeUpdateContinuation,
  updateScreenBanner,
} from "./recognition.ts";

/** Tracks update eligibility separately from the session’s retained input hold. */
export class CodexUpdatePromptTracker {
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

  observe(frameText: string): boolean {
    // Missing classification cannot lend a provisional clear to another frame.
    if (this.pendingClearance) this.observeClearance(false);
    if (codexUpdatePromptVisible(frameText)) {
      if (!this.active) this.generation += 1;
      if (this.requiresBanner && updateScreenBanner.test(frameText)) {
        this.generation += 1;
        this.requiresBanner = false;
      }
      this.active = true;
    } else if (!(this.active && !this.requiresBanner && isSafeUpdateContinuation(frameText))) {
      if (this.active) {
        this.generation += 1;
        this.requiresBanner = true;
        this.pendingClearance = true;
      }
      this.active = false;
      if (!this.deferClearance && this.needsClearance)
        this.observeClearance(this.clearance(frameText));
    }
    return this.active;
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
    return (frameText) =>
      this.active &&
      !this.requiresBanner &&
      this.generation === generation &&
      (codexUpdatePromptVisible(frameText) || isSafeUpdateContinuation(frameText));
  }
}
