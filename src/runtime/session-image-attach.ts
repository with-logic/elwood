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

import {
  type ImageSnapshot,
  materializeImages,
  resolvePaths,
  snapshotImages,
} from "../core/images/index.ts";
import type { ImageInput } from "../core/images/types.ts";

/** A text-submission kind carried by the control queue. */
export type SubmitKind = "prompt" | "message" | "guidance";

/** An attach step run inside a queued op, before the text write. */
type AttachTask = (signal: AbortSignal) => Promise<void>;

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
): Promise<void> {
  if (!images || images.length === 0) return send();
  let snapshot: ImageSnapshot;
  try {
    snapshot = snapshotImages(images); // clone bytes at the call, not at dispatch
  } catch (error) {
    return Promise.reject(error);
  }
  return send((signal) => runAttach(snapshot, driver, signal));
}

/** Resolve paths (async) → materialize → drive the adapter attach → clean up temp files. */
async function runAttach(
  snapshot: ImageSnapshot,
  driver: AttachDriver,
  signal: AbortSignal,
): Promise<void> {
  const resolved = await resolvePaths(snapshot);
  const materialized = await materializeImages(resolved);
  try {
    await driver(materialized.paths, signal);
  } finally {
    await materialized.cleanup().catch(() => undefined);
  }
}
