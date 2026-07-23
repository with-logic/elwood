/**
 * Builds the per-submission image-attach task handed to the control queue. The
 * inputs are SNAPSHOTTED synchronously at the public boundary (byte buffers cloned
 * at the call, paths absolutized), so a caller who mutates its buffer after the
 * call cannot change what is attached — the clone does not wait for queue dispatch.
 * The submission is then enqueued synchronously in call order (preserving FIFO).
 * Inside the queued task, at dispatch, the async pass (path readability/size) runs,
 * then byte materialization and the adapter attach — so a bad input rejects the op
 * (never wedging the queue) and pending submissions accumulate no temp-disk usage.
 * Implements PRD §5.3 (C-API-44).
 */

import { elwoodError } from "../core/errors.ts";
import {
  type ImageSnapshot,
  materializeImages,
  snapshotImages,
  validateImagePaths,
} from "../core/images/index.ts";
import { type ImageInput, imageLimits } from "../core/images/types.ts";

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

/** A text-submission kind carried by the control queue. */
export type SubmitKind = "prompt" | "message" | "guidance";

/** An attach step run inside a queued op, before the text write. */
export type AttachTask = (signal: AbortSignal) => Promise<void>;

/** Drives an adapter's native attach for already-resolved absolute image paths. */
export type AttachDriver = (paths: readonly string[], signal: AbortSignal) => Promise<void>;

/** Queues a submission through the control queue, optionally with an attach task. */
type QueueSend = (attach?: AttachTask) => Promise<void>;

/**
 * Queues a text submission, optionally attaching `images`. With no images it is a
 * plain `send()`; the queue call happens synchronously so a later plain submission
 * cannot overtake an image submission in FIFO order. With images, the byte buffers
 * are cloned SYNCHRONOUSLY here (before the op is queued), so a caller that mutates
 * its buffer after the call cannot change what is attached. A synchronous snapshot
 * failure (bad shape, over-limit bytes) surfaces as a REJECTED promise, never a
 * synchronous throw out of the send API (C-API-44).
 */
export function enqueueSubmission(
  images: readonly ImageInput[] | undefined,
  driver: AttachDriver,
  send: QueueSend,
  budget?: QueuedImageBudget,
): Promise<void> {
  // Fast-path ONLY a truly absent list. Any supplied value — including a non-array
  // like `""` or a zero-length array-like `{ length: 0 }` from an untyped caller —
  // must go through snapshotImages so it rejects with `invalid_image` rather than
  // slipping past validation as a no-image send (C-API-44).
  if (images === undefined) return send();
  let snapshot: ImageSnapshot;
  try {
    snapshot = snapshotImages(images); // validates shape + clones bytes at the call
    budget?.reserve(snapshot.inlineByteTotal); // reserve the clone bytes vs the session ceiling
  } catch (error) {
    return Promise.reject(error);
  }
  const bytes = snapshot.inlineByteTotal;
  if (snapshot.snapshot.length === 0) {
    budget?.release(bytes); // nothing to attach: give the reservation back
    return send();
  }
  // Release on EVERY settle path (attach done, reject, or the op never dispatching), so
  // the clone memory is always accounted back even when a session closes mid-queue.
  const done = send((signal) => runAttach(snapshot, driver, signal));
  done.finally(() => budget?.release(bytes)).catch(() => undefined);
  return done;
}

/** Resolve paths (async) → materialize → drive the adapter attach → clean up temp files. */
async function runAttach(
  snapshot: ImageSnapshot,
  driver: AttachDriver,
  signal: AbortSignal,
): Promise<void> {
  const validated = await validateImagePaths(snapshot);
  const materialized = await materializeImages(validated);
  try {
    await driver(materialized.paths, signal);
  } finally {
    await materialized.cleanup().catch(() => undefined);
  }
}
