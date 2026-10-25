/**
 * Process-local autoupdate/cache guard layered over the cross-process update lease.
 * Implements PRD §9.2 fleet-spawn dedupe, version caching, and the best-effort,
 * never-poisoning update contract (C-LIFE-09, C-LIFE-11).
 */

import { createProbeCache, type ProbeCache } from "../probe-cache.ts";
import type { CommandResult } from "../seams.ts";
import { coordinatedAutoupdate, type UpdateAdapter } from "./lock.ts";

let coordinateUpdate: typeof coordinatedAutoupdate = coordinatedAutoupdate;

/** The outcome of a best-effort autoupdate: it NEVER rejects — a failure is a value. */
export type AutoupdateOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

// The settled autoupdate outcome per adapter. Every `autoupdate: true` caller awaits the SAME
// attempt (concurrent roster spawns run one update); a FAILURE is recorded as a resolved
// `{ok:false}` value, NOT a rejected promise — so one failed update can neither reject the other
// concurrent callers nor poison a later start (C-LIFE-09, C-LIFE-11). Best-effort → not retried.
const autoupdates = new Map<UpdateAdapter, Promise<AutoupdateOutcome>>();

/**
 * Runs the adapter's update at most once per process; concurrent callers share the single
 * in-flight attempt. NEVER rejects — a throwing `runUpdate` resolves to `{ok:false, error}` so the
 * caller can contain it (warn + continue). The cross-process coordinator invalidates the local
 * version cache whether this process owned the update or waited for a peer.
 */
export function cachedAutoupdate(
  adapter: UpdateAdapter,
  runUpdate: () => Promise<void>,
  afterAttempt?: () => void,
): Promise<AutoupdateOutcome> {
  const existing = autoupdates.get(adapter);
  if (existing) return existing;
  const pending = coordinateUpdate(adapter, runUpdate).then(
    () => finalizeAutoupdate(adapter, { ok: true }, afterAttempt),
    (error) => finalizeAutoupdate(adapter, { ok: false, error }, afterAttempt),
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

/** A `--version` read that ran and exited 0; a killed, unspawnable, or failing one is not kept. */
const readSucceeded = (result: CommandResult): boolean =>
  result.status === 0 && result.error === undefined;

// The `--version` read per adapter. Concurrent first spawns share the in-flight PROMISE, so N of
// them start ONE subprocess; once it settles, only a successful read is kept, as a value.
const versionReads: Record<UpdateAdapter, ProbeCache<CommandResult>> = {
  claude: createProbeCache(1, readSucceeded),
  codex: createProbeCache(1, readSucceeded),
};

/**
 * Reads the adapter's `--version` at most once per process. Concurrent first callers share the
 * single in-flight read and its outcome; later callers reuse a successful result. A read that
 * rejects, or resolves with a failed probe (nonzero exit, timeout, spawn error), is not
 * retained, so a transient failure does not poison later callers — they re-attempt (C-LIFE-11).
 * Invalidated after an autoupdate so the post-update version is re-read.
 */
export function cachedVersionRead(
  adapter: UpdateAdapter,
  read: () => Promise<CommandResult>,
): Promise<CommandResult> {
  return versionReads[adapter].get(adapter, read);
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
