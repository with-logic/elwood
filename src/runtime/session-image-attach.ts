/**
 * Builds the per-submission image-attach task handed to the control queue. The
 * submission is enqueued SYNCHRONOUSLY in call order (preserving FIFO). Inside
 * the queued task, at dispatch, validation narrows + defensively copies the
 * inputs (so later caller mutation is inert), then byte materialization and the
 * adapter attach run — so a bad input rejects the op (never wedging the queue)
 * and pending submissions accumulate no temp-disk usage. Implements PRD §5.3
 * (C-API-44).
 */

import { materializeImages, validateImages } from "../core/images/index.ts";
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
 * plain `send()`; the queue call happens synchronously so a later plain
 * submission cannot overtake an image submission in FIFO order (C-API-44).
 */
export function enqueueSubmission(
  images: readonly ImageInput[] | undefined,
  driver: AttachDriver,
  send: QueueSend,
): Promise<void> {
  if (!images || images.length === 0) return send();
  return send((signal) => runAttach(images, driver, signal));
}

/** Validate + snapshot → materialize → drive the adapter attach → clean up temp files. */
async function runAttach(
  images: readonly ImageInput[],
  driver: AttachDriver,
  signal: AbortSignal,
): Promise<void> {
  const validated = await validateImages(images);
  const resolved = await materializeImages(validated);
  try {
    await driver(resolved.paths, signal);
  } finally {
    await resolved.cleanup().catch(() => undefined);
  }
}
