/**
 * Process-local autoupdate/cache guard layered over the cross-process update lease.
 * Implements PRD §9.2 fleet-spawn dedupe, version caching, and the best-effort,
 * never-poisoning update contract (C-LIFE-09, C-LIFE-11).
 */

import { directoryKey } from "../probe/directory-key.ts";
import { createProbeCache, type ProbeCache } from "../probe-cache.ts";
import type { CommandResult } from "../seams.ts";
import { coordinatedAutoupdate, type UpdateAdapter } from "./lock.ts";

let coordinateUpdate: typeof coordinatedAutoupdate = coordinatedAutoupdate;

/**
 * The outcome of a best-effort autoupdate: it NEVER rejects — a failure is a value, naming the
 * directory the shared attempt ran in, which may be another session's launch directory.
 */
export type AutoupdateOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown; readonly updateCwd: string };

// The settled autoupdate outcome per adapter. Every `autoupdate: true` caller awaits the SAME
// attempt (concurrent roster spawns run one update); a FAILURE is recorded as a resolved
// `{ok:false}` value, NOT a rejected promise — so one failed update can neither reject the other
// concurrent callers nor poison a later start (C-LIFE-09, C-LIFE-11). Best-effort → not retried.
const autoupdates = new Map<UpdateAdapter, Promise<AutoupdateOutcome>>();

/**
 * Runs the adapter's update at most once per process, in `cwd`, the launch directory of the
 * start that triggers it; concurrent callers share the single in-flight attempt. NEVER rejects —
 * a throwing `runUpdate` resolves to `{ok:false, error, updateCwd}` so the caller can contain it
 * (warn + continue). The cross-process coordinator invalidates the local version cache whether
 * this process owned the update or waited for a peer.
 */
export function cachedAutoupdate(
  adapter: UpdateAdapter,
  cwd: string,
  runUpdate: () => Promise<void>,
  afterAttempt?: () => void,
): Promise<AutoupdateOutcome> {
  const existing = autoupdates.get(adapter);
  if (existing) return existing;
  const pending = coordinateUpdate(adapter, runUpdate).then(
    () => finalizeAutoupdate(adapter, cwd, { ok: true }, afterAttempt),
    (error) => finalizeAutoupdate(adapter, cwd, { ok: false, error, updateCwd: cwd }, afterAttempt),
  );
  autoupdates.set(adapter, pending);
  return pending;
}

function finalizeAutoupdate(
  adapter: UpdateAdapter,
  cwd: string,
  outcome: AutoupdateOutcome,
  afterAttempt?: () => void,
): AutoupdateOutcome {
  try {
    // A failed installer may still have changed the binary. Invalidate after
    // every attempt, including a peer-owned or failed one, before validation.
    invalidateVersionRead(adapter);
    afterAttempt?.();
    return outcome;
  } catch (error) {
    return { ok: false, error, updateCwd: cwd };
  }
}

/**
 * The most session directories whose successful answers each preflight cache keeps (§9.2). A
 * host runs sessions in a handful of worktrees at once; 32 covers a large fleet's directories,
 * while a full cache, at `maxRetainedVersionTail` per stream, holds at most 8 MiB per adapter.
 */
export const maxSettledPreflightDirectoryResults = 32;

/**
 * The most UTF-16 code units of each output stream a `--version` read keeps: the stream's tail,
 * where the CLI's own output follows the startup files' (C-PERF-02). Bounds the caches above.
 */
export const maxRetainedVersionTail = 64 * 1024;

/**
 * The stream's last `maxRetainedVersionTail` code units, less a low surrogate whose pair was cut
 * off, copied so the kept string does not hold the whole output (V8 slices share their source).
 */
function retainedTail(text: string): string {
  if (text.length <= maxRetainedVersionTail) return text;
  const tail = text.slice(-maxRetainedVersionTail);
  const first = tail.charCodeAt(0);
  const whole = first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
  return Buffer.from(whole, "utf16le").toString("utf16le");
}

/** A `--version` read that ran and exited 0; a killed, unspawnable, or failing one is not kept. */
const readSucceeded = (result: CommandResult): boolean =>
  result.status === 0 && result.error === undefined;

// The `--version` reads per adapter, keyed by the session directory the probe shell starts in:
// a per-directory tool manager can resolve a different binary there (C-PTY-08). Concurrent first
// spawns share the in-flight PROMISE, so N of them start ONE subprocess; once it settles, only a
// successful read is kept, as a value.
const versionReads: Record<UpdateAdapter, ProbeCache<CommandResult>> = {
  claude: createProbeCache(maxSettledPreflightDirectoryResults, readSucceeded),
  codex: createProbeCache(maxSettledPreflightDirectoryResults, readSucceeded),
};

/**
 * Reads the adapter's `--version` in each session directory, and reuses a successful read while
 * the cache keeps it. Concurrent callers share the single in-flight read and its outcome. A read
 * that rejects, or resolves with a failed probe (nonzero exit, timeout, spawn error), is not
 * retained, so the next caller after it settles reads again (C-LIFE-11). A directory evicted from
 * the cache is read again, and so is every directory after an autoupdate invalidates it. Every
 * caller gets the read with each stream cut to its tail (`retainedTail`). A directory deleted and
 * made again at the same path is read afresh: the key is the directory, not only its path.
 */
export async function cachedVersionRead(
  adapter: UpdateAdapter,
  cwd: string,
  read: () => Promise<CommandResult>,
): Promise<CommandResult> {
  return versionReads[adapter].get(await directoryKey(cwd), async () => {
    const result = await read();
    return { ...result, stdout: retainedTail(result.stdout), stderr: retainedTail(result.stderr) };
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
