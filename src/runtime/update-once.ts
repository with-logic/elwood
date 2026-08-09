/**
 * Once-per-process autoupdate guard and version-read cache shared by adapter
 * preflights.
 * Implements PRD §9.2 fleet-spawn autoupdate dedupe, version-read caching, and
 * the best-effort (never-poisoning) update contract (C-LIFE-09, C-LIFE-11).
 */

import type { CommandResult } from "./seams.ts";

type Adapter = "claude" | "codex";

/** The outcome of a best-effort autoupdate: it NEVER rejects — a failure is a value. */
export type AutoupdateOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

// The settled autoupdate outcome per adapter. Every `autoupdate: true` caller awaits the SAME
// attempt (concurrent roster spawns run one update); a FAILURE is recorded as a resolved
// `{ok:false}` value, NOT a rejected promise — so one failed update can neither reject the other
// concurrent callers nor poison a later start (C-LIFE-09, C-LIFE-11). Best-effort → not retried.
const autoupdates = new Map<Adapter, Promise<AutoupdateOutcome>>();

/**
 * Runs the adapter's update at most once per process; concurrent callers share the single
 * in-flight attempt. NEVER rejects — a throwing `runUpdate` resolves to `{ok:false, error}` so the
 * caller can contain it (warn + continue). `runUpdate` should invalidate the version cache on
 * success so the post-update version is re-read.
 */
export function cachedAutoupdate(
  adapter: Adapter,
  runUpdate: () => Promise<void>,
): Promise<AutoupdateOutcome> {
  const existing = autoupdates.get(adapter);
  if (existing) return existing;
  const pending = runUpdate().then(
    (): AutoupdateOutcome => ({ ok: true }),
    (error): AutoupdateOutcome => ({ ok: false, error }),
  );
  autoupdates.set(adapter, pending);
  return pending;
}

// The in-flight/settled `--version` read per adapter. Caching the PROMISE (not the value) means N
// concurrent first spawns share ONE subprocess rather than each starting its own.
const versionReads = new Map<Adapter, Promise<CommandResult>>();

/**
 * Reads the adapter's `--version` at most once per process. Concurrent first callers share the
 * single in-flight read; later callers reuse the settled result. A REJECTED read is evicted (not
 * retained), so a transient failure does not poison later callers — they re-attempt. Invalidated
 * after an autoupdate so the post-update version is re-read.
 */
export function cachedVersionRead(
  adapter: Adapter,
  read: () => Promise<CommandResult>,
): Promise<CommandResult> {
  return dedupeInFlight(versionReads, adapter, read);
}

export function invalidateVersionRead(adapter: Adapter): void {
  versionReads.delete(adapter);
}

/**
 * Share one in-flight promise per key, but EVICT the entry if it rejects, so a rejected result is
 * never retained/replayed to a later caller (which would poison the process). A successful result
 * stays cached for the process lifetime. This is the general guard against the "cached rejected
 * promise poisons every later caller" class of bug (C-LIFE-11).
 */
export function dedupeInFlight<K, T>(
  cache: Map<K, Promise<T>>,
  key: K,
  run: () => Promise<T>,
): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = run();
  cache.set(key, pending);
  // Evict on rejection so the next caller retries rather than inheriting the failure. Identity-
  // guarded (only evict if THIS promise is still cached), so a later successful entry is never
  // clobbered. The `.catch` also keeps the eviction chain from becoming an unhandled rejection.
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}

export function resetAutoupdateForTests(): void {
  autoupdates.clear();
}

export function resetPreflightCacheForTests(): void {
  versionReads.clear();
}
