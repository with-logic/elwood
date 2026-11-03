/**
 * Internal directory-keyed probe caching, with identity compared at read boundaries.
 * Supports the probe implementation of PRD §9.2; directory keys are an implementation detail.
 */

import { stat } from "node:fs/promises";
import { createProbeCache, type ProbeCache } from "../probe-cache.ts";

/**
 * `cwd` and which directory it names (device and inode), so a directory deleted and made again
 * at the same path is probed again rather than answered from the old one's result. None for a
 * path that can't be checked.
 */
async function directoryKey(cwd: string): Promise<string | undefined> {
  try {
    const { dev, ino } = await stat(cwd, { bigint: true });
    return `${dev}:${ino}:${cwd}`;
  } catch {
    return undefined;
  }
}

/** A probe answer, and whether its before/after directory identities matched. */
export type DirectoryRead<T> = { readonly value: T; readonly sameDirectory: boolean };

const directoryCacheBrand = Symbol("DirectoryProbeCache");

/** Only the factory can supply the cache's required boundary-identity admission rule. */
export type DirectoryProbeCache<T> = ProbeCache<DirectoryRead<T>> & {
  readonly [directoryCacheBrand]: true;
};

/** Keeps matching-boundary results only; a caller may further restrict successful values. */
export function createDirectoryProbeCache<T>(
  maxSettledSuccesses: number,
  succeeded: (value: T) => boolean = () => true,
): DirectoryProbeCache<T> {
  return {
    ...createProbeCache<DirectoryRead<T>>(
      maxSettledSuccesses,
      (read) => read.sameDirectory && succeeded(read.value),
    ),
    [directoryCacheBrand]: true,
  };
}

/**
 * `cwd`'s answer from `cache`, else `read()`'s, keyed by path and filesystem identity.
 * The factory refuses retention when identities observed before and after the read differ.
 * The checks compare two snapshots; a replacement restored before the final snapshot
 * can escape detection.
 */
export async function readInDirectory<T>(
  cache: DirectoryProbeCache<T>,
  cwd: string,
  read: () => Promise<T>,
): Promise<T> {
  const key = await directoryKey(cwd);
  // A directory that can't be identified is read, but its answer is neither shared nor kept.
  if (key === undefined) return read();
  const { value } = await cache.get(key, async () => {
    const value = await read();
    return { value, sameDirectory: (await directoryKey(cwd)) === key };
  });
  return value;
}
