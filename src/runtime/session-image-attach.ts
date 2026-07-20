/**
 * Builds the per-submission image-attach task handed to the control queue.
 * Validation runs up front (rejecting the whole submission before it is queued or
 * any temp file exists), while byte materialization is deferred to the attach
 * task at queue-front so pending queued submissions accumulate no temp-disk
 * usage. The task always cleans up temp files. Implements PRD §5.3 (C-API-44).
 */

import { resolveImages, validateImages } from "../core/images/index.ts";
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
 * plain `send()`. With images it VALIDATES them first (rejecting as
 * `invalid_image` before anything is queued), then queues the op whose attach
 * task — run only when the op reaches the queue front — materializes byte inputs,
 * drives the adapter attach, and always removes temp files (C-API-44).
 */
export async function enqueueSubmission(
  images: readonly ImageInput[] | undefined,
  driver: AttachDriver,
  send: QueueSend,
): Promise<void> {
  if (!images || images.length === 0) return send();
  await validateImages(images);
  return send((signal) => runAttach(images, driver, signal));
}

/** Materialize → drive the adapter attach → always clean up temp files. */
async function runAttach(
  images: readonly ImageInput[],
  driver: AttachDriver,
  signal: AbortSignal,
): Promise<void> {
  const resolved = await resolveImages(images);
  try {
    await driver(resolved.paths, signal);
  } finally {
    await resolved.cleanup().catch(() => undefined);
  }
}
