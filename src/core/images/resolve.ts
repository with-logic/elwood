/**
 * Validates + snapshots ImageInput values into a canonical copied form.
 * Snapshotting is SYNCHRONOUS (narrows from `unknown`, enforces count/format/
 * byte-size limits, CLONES byte buffers, absolutizes paths) so a caller who calls
 * a send API and then mutates its buffer cannot change what is attached — the clone
 * happens at the call, not later at queue dispatch. The async pass (filesystem
 * readability + path sizes) is deferred to queue-front. Materialization to temp
 * files lives in `materialize.ts`. Implements PRD §5.3 (C-API-44).
 */

import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { elwoodError } from "../errors.ts";
import { type ImageFormat, type ImageInput, imageFormatExtension, imageLimits } from "./types.ts";

/**
 * A synchronous snapshot: the canonical copied inputs plus the running byte total
 * already accounted from BYTE inputs (path sizes are added later, async).
 */
export type ImageSnapshot = {
  readonly snapshot: readonly ImageInput[];
  /** Bytes already counted toward the aggregate ceiling from byte inputs. */
  readonly inlineByteTotal: number;
};

/**
 * SYNCHRONOUSLY validates, bounds, and defensively COPIES every input without any
 * filesystem access. Narrows each entry from `unknown` so a malformed JS input
 * rejects with `invalid_image` (never a raw TypeError); clones byte buffers and
 * absolutizes paths so a later mutation/`cwd` change cannot alter what is attached
 * (C-API-44). Because this runs at the public send boundary (before the op is
 * queued), the byte clone captures the caller's buffer AT THE CALL — a mutation
 * after the call is inert. The returned snapshot is handed to `validateImagePaths`.
 */
export function snapshotImages(images: readonly ImageInput[]): ImageSnapshot {
  if (!Array.isArray(images)) throw elwoodError("invalid_image", "images must be an array.");
  if (images.length > imageLimits.maxCount)
    throw elwoodError(
      "invalid_image",
      `Too many images: ${images.length} > ${imageLimits.maxCount}`,
    );
  const snapshot: ImageInput[] = [];
  let inlineByteTotal = 0;
  for (const entry of images as readonly unknown[]) {
    const [image, bytes] = snapshotOne(entry, inlineByteTotal);
    snapshot.push(image);
    inlineByteTotal += bytes;
  }
  return { snapshot, inlineByteTotal };
}

/**
 * Async completion of validation: for every PATH entry, stat/readability/size are
 * checked against the SAME aggregate ceiling the byte inputs already consumed. Byte
 * entries need no filesystem work, so this is a no-op for a byte-only snapshot.
 * Runs at queue dispatch (a stat is I/O); byte cloning already happened in
 * `snapshotImages` at the call, so nothing here depends on caller-held state.
 */
export async function validateImagePaths(snap: ImageSnapshot): Promise<readonly ImageInput[]> {
  let total = snap.inlineByteTotal;
  for (const image of snap.snapshot) {
    if (image.path === undefined) continue;
    total += await validatePath(image.path, total);
  }
  return snap.snapshot;
}

/**
 * Validates, bounds, snapshots, then resolves paths — the whole pipeline. A
 * synchronous snapshot failure surfaces as a rejected promise (not a sync throw)
 * so every failure mode reaches callers through one `Promise` channel.
 */
export function validateImages(images: readonly ImageInput[]): Promise<readonly ImageInput[]> {
  let snap: ImageSnapshot;
  try {
    snap = snapshotImages(images);
  } catch (error) {
    return Promise.reject(error);
  }
  return validateImagePaths(snap);
}

/** Narrows one entry (exactly one of path/data), returns its copy plus byte size. */
function snapshotOne(entry: unknown, priorTotal: number): readonly [ImageInput, number] {
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
  // Reject an empty/blank path BEFORE `resolve()` — otherwise `resolve("")` yields
  // the cwd and the later fs check would misreport it as "not a file" (C-API-44).
  if (r.path.trim() === "") throw elwoodError("invalid_image", "Image path is empty.");
  // Path size/readability are checked later (async); absolutize now so the snapshot
  // pins the file a later `cwd` change cannot move. Byte total is unchanged here.
  return [{ path: resolve(r.path) }, 0];
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
