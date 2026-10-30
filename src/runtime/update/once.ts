/**
 * Process-local autoupdate/cache guard layered over the cross-process update lease.
 * Implements PRD §9.2 fleet-spawn dedupe, version caching, and the best-effort,
 * never-poisoning update contract (C-LIFE-09, C-LIFE-11).
 */

import type { DirectoryIdentity } from "../../core/directory-identity.ts";
import { type DirectoryRead, readInDirectory } from "../probe/directory-key.ts";
import { createProbeCache, type ProbeCache } from "../probe-cache.ts";
import type { CommandOptions, CommandResult } from "../seams.ts";
import { coordinatedAutoupdate, type UpdateAdapter } from "./lock.ts";

let coordinateUpdate: typeof coordinatedAutoupdate = coordinatedAutoupdate;

/**
 * The outcome of a best-effort autoupdate: it NEVER rejects — a failure is a value. It is `ok`
 * unless an update command ran and failed, or was skipped for another updater. A failure names
 * `updateCwd`, the directory this process's update command ran in, which may be another
 * launch's; it is absent when no update command ran here (a peer's update was awaited).
 */
export type AutoupdateOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown; readonly updateCwd?: string };

/** One launch's update: check that its launch directory resolves the CLI, then update it. */
export type UpdateSteps = {
  /** Rejects when the CLI is missing, or its check fails, in the launch's directory. */
  readonly verify: () => Promise<unknown>;
  readonly update: () => Promise<void>;
};

/** A settled attempt; `updated` is false when the triggering launch's CLI check failed. */
type Attempt = { readonly updated: boolean; readonly outcome: AutoupdateOutcome };

// The settled autoupdate attempt per adapter. Every `autoupdate: true` caller awaits the SAME
// attempt (concurrent roster spawns run one update); a FAILURE is recorded as a resolved
// `{ok:false}` value, NOT a rejected promise — so one failed update can neither reject the other
// concurrent callers nor poison a later start (C-LIFE-09, C-LIFE-11). Best-effort → not retried.
const autoupdates = new Map<UpdateAdapter, Promise<Attempt>>();

/**
 * Runs the adapter's update at most once per process, in `cwd`, the launch directory of the
 * launch (start or resume) that triggers it; concurrent callers share the single in-flight
 * attempt. NEVER rejects — a throwing update resolves to `{ok:false, error}` so the caller can
 * contain it (warn + continue). The cross-process coordinator invalidates the local version
 * cache whether this process owned the update or waited for a peer.
 *
 * A trigger whose CLI check fails runs no update command, so it is not an attempt: it reports
 * no failure, it is forgotten, and each launch that shared it tries again, in its own directory.
 */
export function cachedAutoupdate(
  adapter: UpdateAdapter,
  cwd: string,
  steps: UpdateSteps,
  afterAttempt?: () => void,
): Promise<AutoupdateOutcome> {
  const existing = autoupdates.get(adapter);
  if (existing) {
    return existing.then((attempt) =>
      attempt.updated ? attempt.outcome : cachedAutoupdate(adapter, cwd, steps, afterAttempt),
    );
  }
  let stage: "waiting" | "verifying" | "updating" = "waiting";
  // The check runs only after this process owns the cross-process lease. Its error still reaches
  // the coordinator, which keeps the lease while a probe group it could not stop is alive.
  const run = async () => {
    stage = "verifying";
    await steps.verify();
    stage = "updating";
    await steps.update();
  };
  const failed = (error: unknown): AutoupdateOutcome =>
    stage === "updating" ? { ok: false, error, updateCwd: cwd } : { ok: false, error };
  const pending = coordinateUpdate(adapter, run)
    .then(
      () => finalizeAutoupdate(adapter, { ok: true }, failed, afterAttempt),
      (error) => finalizeAutoupdate(adapter, failed(error), failed, afterAttempt),
    )
    .then((outcome): Attempt => {
      if (stage !== "verifying") return { updated: true, outcome };
      autoupdates.delete(adapter); // before any sharer retries
      return { updated: false, outcome: { ok: true } };
    });
  autoupdates.set(adapter, pending);
  return pending.then((attempt) => attempt.outcome);
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
 * The most launch directories whose successful reads each per-directory probe cache keeps
 * (§9.2). A host runs sessions in a handful of worktrees at once; 32 covers a large fleet's
 * directories, while a full version cache, at `maxKeptVersionStreamCodeUnits` per stream, holds
 * at most 8 MiB per adapter.
 */
export const maxSettledPreflightDirectoryResults = 32;

/**
 * The most UTF-16 code units of either output stream a kept `--version` read may hold. A longer
 * read is not kept, so every caller parses the whole output and the cache stays bounded above.
 */
export const maxKeptVersionStreamCodeUnits = 64 * 1024;

/**
 * A read worth keeping: it ran and exited 0 (a killed, unspawnable, or failing one is not kept),
 * in the directory it is keyed by, and is small enough to keep.
 */
const keepRead = ({ value, sameDirectory }: DirectoryRead<CommandResult>): boolean =>
  sameDirectory &&
  value.status === 0 &&
  value.error === undefined &&
  value.stdout.length <= maxKeptVersionStreamCodeUnits &&
  value.stderr.length <= maxKeptVersionStreamCodeUnits;

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
 * invalidates it.
 */
export function cachedVersionRead(
  adapter: UpdateAdapter,
  cwd: string,
  read: (options: CommandOptions) => Promise<CommandResult>,
  identity?: DirectoryIdentity,
): Promise<CommandResult> {
  return readInDirectory(versionReads[adapter], cwd, read, identity);
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
