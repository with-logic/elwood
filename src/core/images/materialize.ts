/**
 * Materializes a validated/snapshotted image set to readable absolute file paths.
 * Byte inputs are written to a short-lived temp dir; path inputs pass through
 * (already absolutized at snapshot). A materialize failure removes the temp dir and
 * rethrows as the stable typed `image_attach_failed`, never a raw platform error
 * out of the public send APIs. Implements PRD §5.3 (C-ERR-01/C-API-44).
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { elwoodError } from "../errors.ts";
import { type ImageInput, imageFormatExtension } from "./types.ts";

/** A materialized set of image paths plus the cleanup for any temp files created. */
export type MaterializedImages = {
  readonly paths: readonly string[];
  /** Best-effort removal of temp files; retryable (only clears on success). */
  readonly cleanup: () => Promise<void>;
};

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
