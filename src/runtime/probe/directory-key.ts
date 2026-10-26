/**
 * Per-directory probe answers: the key an answer is cached under, and a read that is kept only
 * for the directory it ran in. Implements the per-directory caches of PRD §9.2 (C-PERF-02).
 */

import { stat } from "node:fs/promises";
import type { ProbeCache } from "../probe-cache.ts";

/**
 * `cwd` and which directory it names (device and inode), so a directory deleted and made again
 * at the same path is probed again rather than answered from the old one's result. A path that
 * can't be checked is keyed by itself: its probe fails, and a failed probe is not kept.
 */
export async function directoryKey(cwd: string): Promise<string> {
  try {
    const { dev, ino } = await stat(cwd, { bigint: true });
    return `${dev}:${ino}:${cwd}`;
  } catch {
    return cwd;
  }
}

/** A probe answer, and whether its directory was still the one it was keyed by. */
export type DirectoryRead<T> = { readonly value: T; readonly sameDirectory: boolean };

/**
 * `cwd`'s answer from `cache`, else `read()`'s, keyed by `cwd`'s directory. The cache's
 * predicate should refuse a read whose `sameDirectory` is false: its directory was replaced
 * while it ran, so it may describe the replacement, and keeping it under the original's key
 * would answer the original with it if that directory came back.
 */
export async function readInDirectory<T>(
  cache: ProbeCache<DirectoryRead<T>>,
  cwd: string,
  read: () => Promise<T>,
): Promise<T> {
  const key = await directoryKey(cwd);
  const { value } = await cache.get(key, async () => {
    const value = await read();
    return { value, sameDirectory: (await directoryKey(cwd)) === key };
  });
  return value;
}
