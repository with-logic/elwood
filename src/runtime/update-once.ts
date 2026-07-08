/**
 * Once-per-process autoupdate guard and version-read cache shared by adapter
 * preflights.
 * Implements PRD §9.2 fleet-spawn autoupdate dedupe and version-read caching.
 */

import type { CommandResult } from "./seams.ts";

type Adapter = "claude" | "codex";

// The in-flight/settled autoupdate per adapter. Every `autoupdate: true`
// caller awaits the SAME update (not just the first) so concurrent roster
// spawns run one update and all observe the same success or failure — no
// caller proceeds on a stale pre-update version or races a second update.
const autoupdates = new Map<Adapter, Promise<void>>();

/**
 * Runs the adapter's update at most once per process; concurrent callers share
 * the single in-flight update. `runUpdate` invalidates the version cache on
 * success so the post-update version is re-read by every caller.
 */
export function cachedAutoupdate(adapter: Adapter, runUpdate: () => Promise<void>): Promise<void> {
  const existing = autoupdates.get(adapter);
  if (existing) return existing;
  const pending = runUpdate();
  autoupdates.set(adapter, pending);
  return pending;
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
  autoupdates.clear();
}

export function resetPreflightCacheForTests(): void {
  versionReads.clear();
}
