/**
 * Validates + snapshots ImageInput values, then materializes them to readable
 * absolute file paths. Validation narrows from `unknown` (JS callers can pass
 * anything), enforces the count/size/format/readability limits, and returns a
 * defensive COPY (byte buffers cloned, paths resolved) so later caller mutation
 * cannot change what is attached. Materialization is async and deferred to
 * queue-front. Implements PRD §5.3 (C-API-44).
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { elwoodError } from "../errors.ts";
import { type ImageFormat, type ImageInput, imageFormatExtension, imageLimits } from "./types.ts";

/** A resolved set of image paths plus the cleanup for any temp files created. */
export type ResolvedImages = {
  readonly paths: readonly string[];
  /** Best-effort removal of temp files; retryable (only clears on success). */
  readonly cleanup: () => Promise<void>;
};

/**
 * Validates, bounds, and defensively COPIES every input WITHOUT writing anything.
 * Narrows each entry from `unknown` so a malformed JS input rejects with
 * `invalid_image` (never a raw TypeError); clones byte buffers and resolves paths
 * to absolute form so a later mutation/`cwd` change cannot alter what is attached
 * (C-API-44). Returns the canonical snapshot to hand to `resolveImages`.
 */
export async function validateImages(
  images: readonly ImageInput[],
): Promise<readonly ImageInput[]> {
  const list = images as readonly unknown[];
  if (list.length > imageLimits.maxCount)
    throw elwoodError("invalid_image", `Too many images: ${list.length} > ${imageLimits.maxCount}`);
  const snapshot: ImageInput[] = [];
  let total = 0;
  for (const entry of list) {
    const [image, bytes] = await validateOne(entry);
    snapshot.push(image);
    total += bytes;
  }
  if (total > imageLimits.maxBytesTotal)
    throw elwoodError(
      "invalid_image",
      `Images exceed the ${imageLimits.maxBytesTotal}-byte total.`,
    );
  return snapshot;
}

/** Narrows one entry, returns its canonical copy plus its byte size. */
async function validateOne(entry: unknown): Promise<readonly [ImageInput, number]> {
  const record = entry as { data?: unknown; format?: unknown; path?: unknown } | null;
  if (record && ArrayBuffer.isView(record.data)) return validateBytes(record.data, record.format);
  if (record && typeof record.path === "string") {
    const size = await validatePath(record.path);
    return [{ path: resolve(record.path) }, size];
  }
  throw elwoodError("invalid_image", "Image must be a { path } or { data, format }.");
}

function validateBytes(view: ArrayBufferView, format: unknown): readonly [ImageInput, number] {
  if (typeof format !== "string" || !Object.hasOwn(imageFormatExtension, format))
    throw elwoodError("invalid_image", `Unsupported image format: ${String(format)}`);
  const data = Uint8Array.from(view as Uint8Array); // clone so later mutation is inert
  if (data.length === 0) throw elwoodError("invalid_image", "Image data is empty.");
  if (data.length > imageLimits.maxBytesPerImage)
    throw elwoodError("invalid_image", "Image data exceeds the per-image size limit.");
  return [{ data, format: format as ImageFormat }, data.length];
}

async function validatePath(path: string): Promise<number> {
  if (path.trim() === "") throw elwoodError("invalid_image", "Image path is empty.");
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

/**
 * Materializes byte inputs (already validated/snapshotted) to one temp dir and
 * returns every absolute path. A materialize failure removes the temp dir before
 * rethrowing, preserving the original error.
 */
export async function resolveImages(images: readonly ImageInput[]): Promise<ResolvedImages> {
  let dir: string | undefined;
  const cleanup = async () => {
    if (!dir) return;
    await rm(dir, { recursive: true, force: true });
    dir = undefined; // cleared only on success → a transient failure stays retryable
  };
  try {
    const paths: string[] = [];
    for (const image of images) {
      if (image.path !== undefined) {
        paths.push(image.path);
        continue;
      }
      dir ??= await mkdtemp(join(tmpdir(), "elwood-image-"));
      const file = join(dir, `${randomUUID()}.${imageFormatExtension[image.format]}`);
      await writeFile(file, image.data);
      paths.push(file);
    }
    return { paths, cleanup };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}
