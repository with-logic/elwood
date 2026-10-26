/**
 * Process-local autoupdate/cache guard layered over the cross-process update lease.
 * Implements PRD §9.2 fleet-spawn dedupe, version caching, and the best-effort,
 * never-poisoning update contract (C-LIFE-09, C-LIFE-11).
 */

import { type DirectoryRead, readInDirectory } from "../probe/directory-key.ts";
import { createProbeCache, type ProbeCache } from "../probe-cache.ts";
import type { CommandResult } from "../seams.ts";
import { coordinatedAutoupdate, type UpdateAdapter } from "./lock.ts";

let coordinateUpdate: typeof coordinatedAutoupdate = coordinatedAutoupdate;

/**
 * The outcome of a best-effort autoupdate: it NEVER rejects — a failure is a value. A failure
 * names `updateCwd`, the directory this process's update command ran in, which may be another
 * launch's; it is absent when no update command ran here (a peer's update was awaited).
 */
export type AutoupdateOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown; readonly updateCwd?: string };

// The settled autoupdate outcome per adapter. Every `autoupdate: true` caller awaits the SAME
// attempt (concurrent roster spawns run one update); a FAILURE is recorded as a resolved
// `{ok:false}` value, NOT a rejected promise — so one failed update can neither reject the other
// concurrent callers nor poison a later start (C-LIFE-09, C-LIFE-11). Best-effort → not retried.
const autoupdates = new Map<UpdateAdapter, Promise<AutoupdateOutcome>>();

/**
 * Runs the adapter's update at most once per process, in `cwd`, the launch directory of the
 * launch (start or resume) that triggers it; concurrent callers share the single in-flight
 * attempt. NEVER rejects — a throwing `runUpdate` resolves to `{ok:false, error}` so the caller
 * can contain it (warn + continue). The cross-process coordinator invalidates the local version
 * cache whether this process owned the update or waited for a peer.
 */
export function cachedAutoupdate(
  adapter: UpdateAdapter,
  cwd: string,
  runUpdate: () => Promise<void>,
  afterAttempt?: () => void,
): Promise<AutoupdateOutcome> {
  const existing = autoupdates.get(adapter);
  if (existing) return existing;
  let ran = false;
  const failed = (error: unknown): AutoupdateOutcome =>
    ran ? { ok: false, error, updateCwd: cwd } : { ok: false, error };
  const update = () => {
    ran = true;
    return runUpdate();
  };
  const pending = coordinateUpdate(adapter, update).then(
    () => finalizeAutoupdate(adapter, { ok: true }, failed, afterAttempt),
    (error) => finalizeAutoupdate(adapter, failed(error), failed, afterAttempt),
  );
  autoupdates.set(adapter, pending);
  return pending;
}

function finalizeAutoupdate(
  adapter: UpdateAdapter,
  outcome: AutoupdateOutcome,
  failed: (error: unknown) => AutoupdateOutcome,
  afterAttempt?: () => void,
): AutoupdateOutcome {
  try {
    // A failed installer may still have changed the binary. Invalidate after
    // every attempt, including a peer-owned or failed one, before validation.
    invalidateVersionRead(adapter);
    afterAttempt?.();
    return outcome;
  } catch (error) {
    return failed(error);
  }
}

/**
 * The most launch directories whose successful `--version` reads each adapter's cache keeps
 * (§9.2). A host runs sessions in a handful of worktrees at once; 32 covers a large fleet's
 * directories, while a full cache, at `maxRetainedVersionTailCodeUnits` per stream, holds at most
 * 8 MiB per adapter.
 */
export const maxSettledPreflightDirectoryResults = 32;

/**
 * The most UTF-16 code units of each output stream a kept `--version` read holds: the stream's
 * tail, where a long output ends with what the CLI said last (C-PERF-02). Bounds the cache above.
 */
export const maxRetainedVersionTailCodeUnits = 64 * 1024;

/**
 * The stream's last `maxRetainedVersionTailCodeUnits` code units, less a low surrogate whose pair
 * was cut off, copied so the kept string does not hold the whole output (V8 slices share their
 * source).
 */
function retainedTail(text: string): string {
  if (text.length <= maxRetainedVersionTailCodeUnits) return text;
  const tail = text.slice(-maxRetainedVersionTailCodeUnits);
  const first = tail.charCodeAt(0);
  const whole = first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
  return Buffer.from(whole, "utf16le").toString("utf16le");
}

/**
 * A read worth keeping: it ran and exited 0 (a killed, unspawnable, or failing one is not kept),
 * in the directory it is keyed by.
 */
const keepRead = ({ value, sameDirectory }: DirectoryRead<CommandResult>): boolean =>
  sameDirectory && value.status === 0 && value.error === undefined;

// The `--version` reads per adapter, keyed by the launch directory their probe shell starts in: a
// per-directory tool manager can resolve a different binary there (C-PTY-08). Concurrent first
// spawns share the in-flight PROMISE, so N of them start ONE subprocess; once it settles, only a
// read worth keeping is kept, as a value.
const versionReads: Record<UpdateAdapter, ProbeCache<DirectoryRead<CommandResult>>> = {
  claude: createProbeCache(maxSettledPreflightDirectoryResults, keepRead),
  codex: createProbeCache(maxSettledPreflightDirectoryResults, keepRead),
};

/**
 * Reads the adapter's `--version` in `cwd`, and reuses a successful read while the cache keeps
 * it. The key is the directory `cwd` names as well as the path, so a directory deleted and made
 * again at the same path is read afresh. Concurrent callers share the single in-flight read and
 * its outcome. A read that rejects, or resolves with a failed probe (nonzero exit, timeout, spawn
 * error), is not kept, so the next caller after it settles reads again (C-LIFE-11); nor is one
 * whose directory was replaced while it ran, since it may have read the replacement's CLI. A
 * directory evicted from the cache is read again, and so is every directory after an autoupdate
 * invalidates it. Every caller gets the read with each stream cut to its tail (`retainedTail`).
 */
export function cachedVersionRead(
  adapter: UpdateAdapter,
  cwd: string,
  read: () => Promise<CommandResult>,
): Promise<CommandResult> {
  return readInDirectory(versionReads[adapter], cwd, async () => {
    const { stdout, stderr, ...rest } = await read();
    return { ...rest, stdout: retainedTail(stdout), stderr: retainedTail(stderr) };
  });
}

export function invalidateVersionRead(adapter: UpdateAdapter): void {
  versionReads[adapter].clear();
}

export function resetAutoupdateForTests(): void {
  autoupdates.clear();
  coordinateUpdate = coordinatedAutoupdate;
}

export function setUpdateCoordinatorForTests(coordinator: typeof coordinatedAutoupdate): void {
  // Unit tests provide in-memory command runners and must never contend with a
  // real desktop host's global update lease. Cross-process coverage calls the
  // production coordinator directly from fresh child processes.
  coordinateUpdate = coordinator;
}

export function resetPreflightCacheForTests(): void {
  for (const cache of Object.values(versionReads)) cache.clear();
}
