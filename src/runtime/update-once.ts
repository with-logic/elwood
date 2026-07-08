/**
 * Once-per-process autoupdate guard and version-read cache shared by adapter
 * preflights.
 * Implements PRD §9.2 fleet-spawn autoupdate dedupe and version-read caching.
 */

import type { CommandResult } from "./seams.ts";

type Adapter = "claude" | "codex";

const updatedAdapters = new Set<Adapter>();

/**
 * True exactly once per adapter per process: parents that spawn a roster of
 * sessions at launch should not run N concurrent same-binary updates.
 */
export function shouldRunAutoupdate(adapter: Adapter): boolean {
  if (updatedAdapters.has(adapter)) return false;
  updatedAdapters.add(adapter);
  return true;
}

// The in-flight/settled `--version` read per adapter. Caching the PROMISE
// (not the value) means N concurrent first spawns share ONE subprocess rather
// than each starting its own before the cache populates — the burst this fix
// targets.
const versionReads = new Map<Adapter, Promise<CommandResult>>();

/**
 * Reads the adapter's `--version` at most once per process. Concurrent first
 * callers share the single in-flight read; later callers reuse the settled
 * result. Invalidated after an autoupdate so the post-update version is
 * re-read.
 */
export function cachedVersionRead(
  adapter: Adapter,
  read: () => Promise<CommandResult>,
): Promise<CommandResult> {
  const existing = versionReads.get(adapter);
  if (existing) return existing;
  const pending = read();
  versionReads.set(adapter, pending);
  return pending;
}

export function invalidateVersionRead(adapter: Adapter): void {
  versionReads.delete(adapter);
}

export function resetAutoupdateForTests(): void {
  updatedAdapters.clear();
}

export function resetPreflightCacheForTests(): void {
  versionReads.clear();
}
