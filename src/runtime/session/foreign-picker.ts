/** Preserve a foreign model-dialog hold until positive composer clearance (C-API-55). */
import type { ModelPickerSpec } from "../../core/models/picker.ts";
import { clearFrames } from "./picker-cleanup.ts";

export class ForeignPickerHold {
  private held = false;
  private clearStreak = 0;

  observe(text: string, spec: ModelPickerSpec): boolean {
    if (spec.isCandidate(text)) {
      this.held = true;
      this.clearStreak = 0;
    } else if (this.held) {
      this.clearStreak = spec.isClear(text) ? this.clearStreak + 1 : 0;
      if (this.clearStreak >= clearFrames) this.held = false;
    }
    return this.held;
  }
}
