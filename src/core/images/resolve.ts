/**
 * Resolves ImageInput values to readable absolute file paths for the adapter
 * attach paths (which are file- or clipboard-based), materializing byte inputs
 * to short-lived temp files and cleaning every temp file up afterward.
 * Implements PRD §5.3 (C-API-44).
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { elwoodError } from "../errors.ts";
import { type ImageFormat, type ImageInput, imageFormatExtension } from "./types.ts";

/** A resolved set of image paths plus the cleanup for any temp files created. */
export type ResolvedImages = {
  readonly paths: readonly string[];
  /** Removes every temp file materialized for this set; safe to call once. */
  readonly cleanup: () => void;
};

const supportedFormats = new Set<ImageFormat>(["png", "jpeg", "gif", "webp"]);

/**
 * Validates and resolves every input to an absolute path. Byte inputs are
 * written under one temp directory removed by `cleanup`. A path that is not a
 * readable regular file, or bytes with an unsupported format, reject with
 * `invalid_image` BEFORE any temp file is written, so the caller can abort the
 * whole submission before any partial input reaches the composer (C-API-44).
 */
export function resolveImages(images: readonly ImageInput[]): ResolvedImages {
  for (const image of images) validateImage(image);
  let dir: string | undefined;
  const cleanup = () => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  };
  try {
    const paths = images.map((image) => {
      if ("path" in image) return resolve(image.path);
      dir ??= mkdtempSync(join(tmpdir(), "elwood-image-"));
      const file = join(dir, `${randomUUID()}.${imageFormatExtension[image.format]}`);
      writeFileSync(file, image.data);
      return file;
    });
    return { paths, cleanup };
  } catch (error) {
    // A materialize failure (e.g. disk full) removes any temp dir before rethrow.
    cleanup();
    throw error;
  }
}

/** Rejects an input that cannot become a readable image file (C-API-44). */
function validateImage(image: ImageInput): void {
  if ("data" in image) {
    if (!supportedFormats.has(image.format))
      throw elwoodError("invalid_image", `Unsupported image format: ${image.format}`);
    if (image.data.length === 0) throw elwoodError("invalid_image", "Image data is empty.");
    return;
  }
  if (!isAbsolute(image.path) && image.path.trim() === "")
    throw elwoodError("invalid_image", "Image path is empty.");
  const stat = statImage(image.path);
  if (!stat) throw elwoodError("invalid_image", `Image path is not readable: ${image.path}`);
  if (!stat.isFile()) throw elwoodError("invalid_image", `Image path is not a file: ${image.path}`);
}

function statImage(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}
