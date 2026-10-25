/**
 * Holds input on a model dialog, whoever opened it, until positive composer clearance is
 * sustained (C-API-55).
 */
import type { ModelPickerSpec } from "../../core/models/picker.ts";
import { clearFrames, clearObservationGapMs } from "./picker-cleanup.ts";

export class PickerHold {
  private held = false;
  private clearStreak = 0;
  private lastCounted = Number.NEGATIVE_INFINITY;

  /** Holds as if a dialog were seen, until the same sustained clearance releases it. */
  hold(): void {
    this.held = true;
    this.restart();
  }

  /**
   * Reads one frame. A dialog candidate holds. While held, any frame that is not positively
   * clear restarts the streak, and a clear one counts only `clearObservationGapMs` after the
   * last counted one: readings bunched into one instant, or a burst of repaints, count once.
   * Idle CLIs do not repaint, so the evidence is the same completed frame read over time.
   */
  observe(text: string, spec: ModelPickerSpec): boolean {
    if (spec.isCandidate(text)) this.hold();
    else if (this.held && !spec.isClear(text)) this.restart();
    else if (this.held && Date.now() - this.lastCounted >= clearObservationGapMs) {
      this.clearStreak += 1;
      this.lastCounted = Date.now();
      if (this.clearStreak >= clearFrames) this.held = false;
    }
    return this.held;
  }

  private restart(): void {
    this.clearStreak = 0;
    this.lastCounted = Number.NEGATIVE_INFINITY;
  }
}
