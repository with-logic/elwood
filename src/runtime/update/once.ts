/**
 * Process-local autoupdate/cache guard layered over the cross-process update lease.
 * Implements PRD §9.2 fleet-spawn dedupe, version caching, and the best-effort,
 * never-poisoning update contract (C-LIFE-09, C-LIFE-11).
 */

import { UpdateVerificationFailure } from "../../core/update-verification.ts";
import {
  createDirectoryProbeCache,
  type DirectoryProbeCache,
  type ProbeDirectory,
  readInDirectory,
} from "../probe/directory-key.ts";
import type { CommandOptions, CommandResult } from "../seams.ts";
import { coordinatedAutoupdate, type UpdateAdapter } from "./lock.ts";

let coordinateUpdate: typeof coordinatedAutoupdate = coordinatedAutoupdate;

/** The outcome of a best-effort autoupdate: it NEVER rejects — a failure is a value. */
export type AutoupdateOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

// The settled autoupdate outcome per adapter. Every `autoupdate: true` caller awaits the SAME
// attempt (concurrent roster spawns run one update); a FAILURE is recorded as a resolved
// `{ok:false}` value, NOT a rejected promise — so one failed update can neither reject the other
// concurrent callers nor poison a later start (C-LIFE-09, C-LIFE-11). Actual attempts are not retried.
const autoupdates = new Map<UpdateAdapter, Promise<AutoupdateOutcome>>();

/**
 * Runs the adapter's updater at most once per process; local non-attempts permit a later retry.
 * Concurrent callers share the single
 * in-flight attempt. NEVER rejects — a throwing `runUpdate` resolves to `{ok:false, error}` so the
 * caller can contain it (warn + continue). The cross-process coordinator invalidates the local
 * version cache whether this process owned the update or waited for a peer. The one exception
 * is test-only: after `resetAutoupdateForTests()`, until a test sets a coordinator, it throws
 * at once instead of returning.
 */
export function cachedAutoupdate(
  adapter: UpdateAdapter,
  runUpdate: () => Promise<void>,
  afterAttempt?: () => void,
): Promise<AutoupdateOutcome> {
  const existing = autoupdates.get(adapter);
  if (existing) return existing;
  let entered = false;
  const pending = coordinateUpdate(adapter, () => {
    entered = true;
    return runUpdate();
  }).then(
    () => finalizeAutoupdate(adapter, { ok: true }, afterAttempt),
    (error) => {
      if (!entered || error instanceof UpdateVerificationFailure) autoupdates.delete(adapter);
      return finalizeAutoupdate(adapter, { ok: false, error }, afterAttempt);
    },
  );
  autoupdates.set(adapter, pending);
  return pending;
}

function finalizeAutoupdate(
  adapter: UpdateAdapter,
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
    return { ok: false, error };
  }
}

/** Settled directory results and retained version-text bounds (C-PERF-02). */
export const maxSettledPreflightDirectoryResults = 32;
export const maxKeptVersionStreamCodeUnits = 64 * 1024;

/** Retain only successful version results with at most 65,536 UTF-16 units per stream. */
const isCacheableVersionResult = (result: CommandResult): boolean =>
  result.status === 0 &&
  result.error === undefined &&
  result.stdout.length <= maxKeptVersionStreamCodeUnits &&
  result.stderr.length <= maxKeptVersionStreamCodeUnits;

// Matching directory reads share a run; retain at most 32 successful directory identities
// per adapter. Every update attempt invalidates all of that adapter's directory entries.
const versionReads: Record<UpdateAdapter, DirectoryProbeCache<CommandResult>> = {
  claude: createDirectoryProbeCache(maxSettledPreflightDirectoryResults, isCacheableVersionResult),
  codex: createDirectoryProbeCache(maxSettledPreflightDirectoryResults, isCacheableVersionResult),
};

/**
 * Reads the adapter's `--version` per observed directory. Concurrent callers share the
 * in-flight read and its outcome. Retain up to 32 successful directory results whose stdout
 * and stderr each contain at most 65,536 UTF-16 units. Oversized successes are returned
 * without retention. Rejections and failed probes (nonzero exit, timeout, spawn error) are
 * not retained, so the next caller after settlement reads again (C-LIFE-11). Every update
 * attempt invalidates all directory results before callers validate their installed version.
 */
export function cachedVersionRead(
  adapter: UpdateAdapter,
  read: (options: CommandOptions) => Promise<CommandResult>,
  directory: ProbeDirectory = { cwd: process.cwd() },
): Promise<CommandResult> {
  return readInDirectory(versionReads[adapter], directory.cwd, read, directory.identity);
}

export function invalidateVersionRead(adapter: UpdateAdapter): void {
  versionReads[adapter].clear();
}

/**
 * Stands in for the coordinator after a reset, until a test sets one. The production coordinator
 * takes its default root from the passwd database, not `HOME`, so a test's private `HOME` would
 * not keep it out of the developer's real lease root. It throws rather than rejects: a rejection
 * would be contained as a best-effort update's warning, and the preflight would carry on.
 */
function refuseRealUpdateRoot(): never {
  throw new Error("set a private update root: call setUpdateCoordinatorForTests after the reset");
}

/** Clears the update attempts, and refuses any further update until a test sets a coordinator. */
export function resetAutoupdateForTests(): void {
  autoupdates.clear();
  coordinateUpdate = refuseRealUpdateRoot;
}

/** Whether an update would be refused: true from a reset until a test sets a coordinator. */
export function updatesRefusedForTests(): boolean {
  return coordinateUpdate === refuseRealUpdateRoot;
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
