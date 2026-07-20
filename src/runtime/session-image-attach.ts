/**
 * Builds the per-submission image-attach task handed to the control queue. It
 * resolves ImageInput values to readable paths up front (rejecting the whole
 * submission before any partial input reaches the composer), then returns a task
 * that drives the adapter's native attach path and always cleans up temp files.
 * Implements PRD §5.3 (C-API-44).
 */

import { type ResolvedImages, resolveImages } from "../core/images/index.ts";
import type { ImageInput } from "../core/images/types.ts";

/** A text-submission kind carried by the control queue. */
export type SubmitKind = "prompt" | "message" | "guidance";

/** An attach step run inside a queued op, before the text write. */
export type AttachTask = (signal: AbortSignal) => Promise<void>;

/** Drives an adapter's native attach for already-resolved absolute image paths. */
export type AttachDriver = (paths: readonly string[], signal: AbortSignal) => Promise<void>;

/** Queues a submission through the control queue, optionally with an attach task. */
export type QueueSend = (attach?: AttachTask) => Promise<void>;

/**
 * Queues a text submission, optionally attaching `images`. With no images it is
 * a plain `send()`. With images it resolves them synchronously (a rejection
 * propagates as `invalid_image`/`unsupported_platform` BEFORE anything queues),
 * queues the op with an attach task, and guarantees temp-file cleanup even when
 * the op never dispatches (session terminal) — pasting nothing (C-API-44).
 */
export function enqueueSubmission(
  images: readonly ImageInput[] | undefined,
  driver: AttachDriver,
  send: QueueSend,
): Promise<void> {
  if (!images || images.length === 0) return send();
  let prepared: PreparedAttach;
  try {
    prepared = prepareImageAttach(images, driver);
  } catch (error) {
    return Promise.reject(error);
  }
  let attached = false;
  return send((signal) => {
    attached = true;
    return prepared.attach(signal);
  }).catch((error: unknown) => {
    if (!attached) prepared.cleanup(); // op never dispatched → drop temp files, paste nothing
    throw error;
  });
}

/** A queue attach task plus a standalone cleanup for the not-queued path. */
export type PreparedAttach = {
  // Runs the adapter attach then removes temp files (on success or failure).
  readonly attach: (signal: AbortSignal) => Promise<void>;
  // Removes temp files WITHOUT driving the attach — used when the op is never
  // queued (e.g. the session is not running), so nothing is pasted (C-API-44).
  readonly cleanup: () => void;
};

/**
 * Resolves `images` now (may throw `invalid_image`/`unsupported_platform`
 * synchronously, before anything is queued), and returns an attach task that
 * runs the driver and then removes any temp files — on success or failure — so
 * the queued op carries text and images as one turn (C-API-44).
 */
export function prepareImageAttach(
  images: readonly ImageInput[],
  driver: AttachDriver,
): PreparedAttach {
  const resolved: ResolvedImages = resolveImages(images);
  const attach = async (signal: AbortSignal): Promise<void> => {
    try {
      await driver(resolved.paths, signal);
    } finally {
      resolved.cleanup();
    }
  };
  return { attach, cleanup: resolved.cleanup };
}
