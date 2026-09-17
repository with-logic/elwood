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

// ONE budget per session object. A facade registers its own before it exposes the session it
// launched, so both surfaces reserve against the same ceiling rather than 200 MiB each.
const sessionBudgets = new WeakMap<object, QueuedImageBudget>();

/** The budget every image submission on `session` reserves against (created on first use). */
export function sessionImageBudget(session: object): QueuedImageBudget {
  const existing = sessionBudgets.get(session);
  if (existing !== undefined) return existing;
  const created = new QueuedImageBudget();
  sessionBudgets.set(session, created);
  return created;
}

/** Makes `budget` the one `session` reserves against, replacing the session's own. */
export function shareImageBudget(session: object, budget: QueuedImageBudget): void {
  sessionBudgets.set(session, budget);
}
