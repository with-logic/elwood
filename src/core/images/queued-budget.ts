/** Bounds queued image ownership across sends (PRD §5.3, C-API-44). */
import { elwoodError } from "../errors.ts";
import { imageLimits } from "./types.ts";

/**
 * A per-session aggregate byte budget for image clones held across ALL not-yet-attached
 * queued submissions. Reserved synchronously when a submission's bytes are cloned and
 * released when it settles, so a slow paste can't let a caller retain gigabytes of
 * queued clones (C-API-44).
 */
export class QueuedImageBudget {
  private used = 0;
  private readonly ceiling: number;
  constructor(ceiling = imageLimits.maxQueuedBytes) {
    this.ceiling = ceiling;
  }
  reserve(bytes: number): void {
    if (this.used + bytes > this.ceiling)
      throw elwoodError("invalid_image", "Too many queued image bytes for this session.");
    this.used += bytes;
  }
  release(bytes: number): void {
    this.used = Math.max(0, this.used - bytes);
  }
}
