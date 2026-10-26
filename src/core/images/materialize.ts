/**
 * Materializes a validated/snapshotted image set to readable absolute file paths.
 * Byte inputs are written to a short-lived temp dir; path inputs pass through
 * (already absolutized at snapshot). A materialize failure removes the temp dir and
 * rethrows as the stable typed `image_attach_failed`, never a raw platform error
 * out of the public send APIs. An abort of the attach removes the temp dir at once,
 * whether it lands during the writes or after them, so a closing session's `stop`,
 * `kill`, or `teardown` resolves with it gone unless that best-effort removal fails;
 * `cleanup` then retries it once the attach unwinds. Implements PRD §5.3 and §8.4
 * (C-ERR-01/C-API-44).
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { elwoodError } from "../errors.ts";
import { type ImageInput, imageFormatExtension } from "./types.ts";

/** A materialized set of image paths plus the cleanup for any temp files created. */
export type MaterializedImages = {
  readonly paths: readonly string[];
  /**
   * Best-effort removal of temp files, retryable (only clears on success). It also stops
   * watching the attach's abort signal.
   */
  readonly cleanup: () => Promise<void>;
};

type TempDir = { readonly path: string; readonly remove: () => Promise<void> };

/**
 * Makes the temp dir synchronously and watches `signal` from that same tick, so an abort
 * at any later point removes the dir before the code that aborted resumes. A write still
 * in flight then lands in a removed dir and fails. A removal that fails at abort stays
 * for `remove` to retry.
 */
function makeTempDir(signal: AbortSignal | undefined): TempDir {
  const path = mkdtempSync(join(tmpdir(), "elwood-image-"));
  let present = true;
  const removeNow = () => {
    try {
      rmSync(path, { recursive: true, force: true });
      present = false;
    } catch {
      // Best-effort: `remove` retries once the attach unwinds.
    }
  };
  signal?.addEventListener("abort", removeNow, { once: true });
  return {
    path,
    remove: async () => {
      signal?.removeEventListener("abort", removeNow);
      if (!present) return;
      await rm(path, { recursive: true, force: true });
      present = false; // cleared only on success → a transient failure stays retryable
    },
  };
}

/**
 * Materializes byte inputs (already validated/snapshotted) to one temp dir and
 * returns every absolute path. A materialize failure (e.g. ENOSPC) removes the
 * temp dir, then rethrows as the stable typed `image_attach_failed` — never a raw
 * platform error out of the public send APIs (C-ERR-01/C-API-44). `signal` is the
 * attach's abort signal: an attach already aborted writes nothing, and a later abort
 * removes the temp dir at once (`makeTempDir`).
 */
export async function materializeImages(
  images: readonly ImageInput[],
  signal?: AbortSignal,
): Promise<MaterializedImages> {
  signal?.throwIfAborted();
  let temp: TempDir | undefined;
  const cleanup = async () => {
    await temp?.remove();
  };
  try {
    const paths: string[] = [];
    for (const image of images) {
      if (image.path !== undefined) {
        paths.push(image.path);
        continue;
      }
      temp ??= makeTempDir(signal);
      const file = join(temp.path, `${randomUUID()}.${imageFormatExtension[image.format]}`);
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
