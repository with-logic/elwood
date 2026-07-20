/**
 * Resolves ImageInput values to readable absolute file paths for the adapter
 * attach paths (which are file- or clipboard-based). Validation and size limits
 * run BEFORE any temp file is written; byte inputs are materialized to a
 * short-lived temp dir removed by `cleanup`. Async so large writes/metadata
 * lookups never block the event loop on the API hot path.
 * Implements PRD §5.3 (C-API-44).
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { elwoodError } from "../errors.ts";
import { type ImageInput, imageFormatExtension, imageLimits } from "./types.ts";

/** A resolved set of image paths plus the cleanup for any temp files created. */
export type ResolvedImages = {
  readonly paths: readonly string[];
  /** Removes every temp file materialized for this set; safe to call repeatedly. */
  readonly cleanup: () => Promise<void>;
};

/**
 * Validates + bounds every input WITHOUT writing anything: rejects with
 * `invalid_image` on an unsupported/empty format, an unreadable path, or a
 * count/size past the documented limits (C-API-44). Run before an image
 * submission is queued so a bad input is rejected before the composer is touched
 * and before any temp file exists.
 */
export async function validateImages(images: readonly ImageInput[]): Promise<void> {
  await validateAll(images);
}

/**
 * Materializes byte inputs to one temp dir and returns every absolute path. Meant
 * to run at queue-front (when the op actually dispatches), so pending queued
 * submissions do not accumulate temp-disk usage. Assumes `validateImages` already
 * passed. A materialize failure removes the temp dir before rethrowing, preserving
 * the original error.
 */
export async function resolveImages(images: readonly ImageInput[]): Promise<ResolvedImages> {
  let dir: string | undefined;
  const cleanup = async () => {
    if (!dir) return;
    // Remove the temp dir, then null it so the cleanup is idempotent — but only
    // AFTER a successful removal, so a transient failure stays retryable rather
    // than leaking the dir silently.
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  };
  try {
    const paths: string[] = [];
    for (const image of images) {
      if (image.path !== undefined) {
        paths.push(resolve(image.path));
        continue;
      }
      dir ??= await mkdtemp(join(tmpdir(), "elwood-image-"));
      const file = join(dir, `${randomUUID()}.${imageFormatExtension[image.format]}`);
      await writeFile(file, image.data);
      paths.push(file);
    }
    return { paths, cleanup };
  } catch (error) {
    // A materialize failure (disk full) removes the temp dir before rethrow; the
    // ORIGINAL error is preserved (a cleanup failure never replaces it).
    await cleanup().catch(() => undefined);
    throw error;
  }
}

async function validateAll(images: readonly ImageInput[]): Promise<void> {
  if (images.length > imageLimits.maxCount)
    throw elwoodError(
      "invalid_image",
      `Too many images: ${images.length} > ${imageLimits.maxCount}`,
    );
  let total = 0;
  for (const image of images) total += await validateImage(image);
  if (total > imageLimits.maxBytesTotal)
    throw elwoodError(
      "invalid_image",
      `Images exceed the ${imageLimits.maxBytesTotal}-byte total.`,
    );
}

/** Validates one input and returns its byte size (for the aggregate cap). */
async function validateImage(image: ImageInput): Promise<number> {
  if (image.data !== undefined) {
    if (!(image.format in imageFormatExtension))
      throw elwoodError("invalid_image", `Unsupported image format: ${image.format}`);
    if (image.data.length === 0) throw elwoodError("invalid_image", "Image data is empty.");
    if (image.data.length > imageLimits.maxBytesPerImage)
      throw elwoodError("invalid_image", "Image data exceeds the per-image size limit.");
    return image.data.length;
  }
  return await validatePath(image.path);
}

async function validatePath(path: string): Promise<number> {
  if (!isAbsolute(path) && path.trim() === "")
    throw elwoodError("invalid_image", "Image path is empty.");
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw elwoodError("invalid_image", `Image path is not a file: ${path}`);
    await access(path, constants.R_OK); // readability, not mere existence (C-API-44)
    size = info.size;
  } catch (error) {
    if (error instanceof Error && error.name === "ElwoodError") throw error;
    throw elwoodError("invalid_image", `Image path is not a readable file: ${path}`);
  }
  if (size > imageLimits.maxBytesPerImage)
    throw elwoodError("invalid_image", `Image file exceeds the per-image size limit: ${path}`);
  return size;
}
