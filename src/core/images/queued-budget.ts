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
  private usedBytes = 0;
  private readonly maxQueuedBytes: number;
  constructor(maxQueuedBytes = imageLimits.maxQueuedBytes) {
    this.maxQueuedBytes = maxQueuedBytes;
  }
  reserve(bytes: number): void {
    if (this.usedBytes + bytes > this.maxQueuedBytes)
      throw elwoodError("invalid_image", "Too many queued image bytes for this session.");
    this.usedBytes += bytes;
  }
  release(bytes: number): void {
    this.usedBytes = Math.max(0, this.usedBytes - bytes);
  }
}
