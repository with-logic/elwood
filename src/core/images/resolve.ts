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

/** A materialized set of image paths plus the cleanup for any temp files created. */
export type MaterializedImages = {
  readonly paths: readonly string[];
  /** Best-effort removal of temp files; retryable (only clears on success). */
  readonly cleanup: () => Promise<void>;
};

/**
 * Validates, bounds, and defensively COPIES every input WITHOUT writing anything.
 * Narrows each entry from `unknown` so a malformed JS input rejects with
 * `invalid_image` (never a raw TypeError); clones byte buffers and resolves paths
 * to absolute form so a later mutation/`cwd` change cannot alter what is attached
 * (C-API-44). Returns the canonical snapshot to hand to `materializeImages`.
 */
export async function validateImages(
  images: readonly ImageInput[],
): Promise<readonly ImageInput[]> {
  if (!Array.isArray(images)) throw elwoodError("invalid_image", "images must be an array.");
  if (images.length > imageLimits.maxCount)
    throw elwoodError(
      "invalid_image",
      `Too many images: ${images.length} > ${imageLimits.maxCount}`,
    );
  const snapshot: ImageInput[] = [];
  let total = 0;
  for (const entry of images as readonly unknown[]) {
    const [image, bytes] = await validateOne(entry, total);
    snapshot.push(image);
    total += bytes;
  }
  return snapshot;
}

/** Narrows one entry (exactly one of path/data), returns its copy plus byte size. */
async function validateOne(
  entry: unknown,
  priorTotal: number,
): Promise<readonly [ImageInput, number]> {
  const r = entry as { data?: unknown; format?: unknown; path?: unknown } | null;
  const hasData = !!r && r.data !== undefined;
  const hasPath = !!r && r.path !== undefined;
  if (hasData === hasPath)
    throw elwoodError(
      "invalid_image",
      "Image must be exactly one of { path } or { data, format }.",
    );
  // The shape must be EXACTLY the selected variant's keys — no extra own keys — so a
  // caller cannot smuggle unexpected fields past validation (C-API-44).
  rejectExtraKeys(r as object, hasData ? ["data", "format"] : ["path"]);
  if (hasData) return validateBytes((r as { data: unknown }).data, r?.format, priorTotal);
  if (typeof r?.path !== "string")
    throw elwoodError("invalid_image", "Image path must be a string.");
  return [{ path: resolve(r.path) }, await validatePath(r.path, priorTotal)];
}

/** Rejects an image entry that carries own keys outside its variant's exact shape. */
function rejectExtraKeys(entry: object, allowed: readonly string[]): void {
  for (const key of Object.keys(entry)) {
    if (!allowed.includes(key))
      throw elwoodError("invalid_image", `Image has an unexpected field: ${key}`);
  }
}

// Only Uint8Array/Buffer bytes are accepted (other views would truncate/misread),
// and BOTH size limits are checked BEFORE cloning so an over-limit input never
// triggers a large duplicate allocation (C-API-44).
function validateBytes(
  data: unknown,
  format: unknown,
  priorTotal: number,
): readonly [ImageInput, number] {
  if (typeof format !== "string" || !Object.hasOwn(imageFormatExtension, format))
    throw elwoodError("invalid_image", `Unsupported image format: ${String(format)}`);
  if (!(data instanceof Uint8Array))
    throw elwoodError("invalid_image", "Image data must be a Uint8Array.");
  if (data.length === 0) throw elwoodError("invalid_image", "Image data is empty.");
  if (data.length > imageLimits.maxBytesPerImage)
    throw elwoodError("invalid_image", "Image data exceeds the per-image size limit.");
  if (priorTotal + data.length > imageLimits.maxBytesTotal)
    throw elwoodError(
      "invalid_image",
      `Images exceed the ${imageLimits.maxBytesTotal}-byte total.`,
    );
  return [{ data: Uint8Array.from(data), format: format as ImageFormat }, data.length];
}

async function validatePath(path: string, priorTotal: number): Promise<number> {
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
  // Path images count toward the SAME aggregate ceiling as byte inputs, so a set of
  // large files cannot bypass the total-size limit that byte inputs enforce (C-API-44).
  if (priorTotal + size > imageLimits.maxBytesTotal)
    throw elwoodError(
      "invalid_image",
      `Images exceed the ${imageLimits.maxBytesTotal}-byte total.`,
    );
  return size;
}

/**
 * Materializes byte inputs (already validated/snapshotted) to one temp dir and
 * returns every absolute path. A materialize failure (e.g. ENOSPC) removes the
 * temp dir, then rethrows as the stable typed `image_attach_failed` — never a raw
 * platform error out of the public send APIs (C-ERR-01/C-API-44).
 */
export async function materializeImages(
  images: readonly ImageInput[],
): Promise<MaterializedImages> {
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
    throw elwoodError("image_attach_failed", "Could not materialize an image for attachment.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
