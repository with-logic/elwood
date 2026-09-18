/**
 * Cross-process lease for globally mutating agent updates.
 * Implements PRD §9.2, C-LIFE-09, and C-PERF-04: separate Elwood hosts for
 * one macOS user serialize per-adapter updates and recover a killed owner's lease.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, opendir, rename, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { elwoodError } from "../../core/errors.ts";
import { waitForProbeGroups } from "../probe-cleanup.ts";
import {
  type LeaseOwner,
  ownerFile,
  readOptionalText,
  releaseLease,
  retiredLeaseInfix,
  serializeOwner,
  unresolvedProbeGroup,
} from "./owner.ts";
import { retainLease } from "./retained-lease.ts";
import { pathExists, recoveryPath, waitForOwner } from "./waiting.ts";

export type UpdateAdapter = "claude" | "codex";

export type UpdateLeaseOptions = {
  readonly root?: string;
  readonly pollMs?: number;
  readonly staleMs?: number;
  readonly waitMs?: number;
  readonly retainRetryMs?: number;
};

const defaultPollMs = 50;
const defaultStaleMs = 30_000;
const maxSweptLeftovers = 8;
const maxInspectedEntries = 64;
const defaultWaitMs = 60_000;
const defaultRetainRetryMs = 1_000;

function defaultLeaseRoot(): string {
  const user = userInfo();
  return join(user.homedir, "Library", "Caches", "elwood", `${user.uid}-updates`);
}

export function updateLockPath(adapter: UpdateAdapter, root = defaultLeaseRoot()): string {
  return join(root, `${adapter}.lock`);
}

/**
 * Runs `update` only for the lease owner. A contender waits until that owner
 * settles and then returns without a duplicate update; callers re-read version
 * state after this resolves. Waiting uses timers, never a blocking filesystem loop.
 * After 60 seconds by default, a still-active owner rejects with the adapter's
 * update_failed error and updateReason active_owner; preflight warns and continues.
 */
export async function coordinatedAutoupdate(
  adapter: UpdateAdapter,
  update: () => Promise<void>,
  options: UpdateLeaseOptions = {},
): Promise<void> {
  const root = options.root ?? defaultLeaseRoot();
  const path = updateLockPath(adapter, root);
  const pollMs = options.pollMs ?? defaultPollMs;
  const staleMs = options.staleMs ?? defaultStaleMs;
  // Monotonic: the wait is a promised bound, so a backward system-clock adjustment must
  // not extend it. `mtime` staleness below stays on the wall clock, which is what it is.
  const waitUntilMs = performance.now() + (options.waitMs ?? defaultWaitMs);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const owner = { pid: process.pid, token: randomUUID() } satisfies LeaseOwner;
  const completion = join(root, `${adapter}.completed`);
  const priorCompletion = await readOptionalText(completion);
  let observedActive = (await pathExists(path)) || (await pathExists(recoveryPath(path)));
  let recoveredStale = false;
  while (!(await claimLease(path, owner))) {
    // Losing the claim to an existing lease IS an observation of an active owner; a claim
    // that failed on its own staging finds no lease below and returns as released. Sampling
    // only before the loop misses a peer that claimed in the interim, and that contender
    // would then treat its own later claim as the first attempt and run a duplicate
    // update (PRD §9.2: a contender skips its duplicate attempt).
    observedActive = true;
    const waited = await waitForOwner(path, pollMs, staleMs, waitUntilMs);
    if (waited === "released") return;
    if (waited === "wait_expired") {
      throw elwoodError(`${adapter}_update_failed`, "Another updater has not finished.", {
        updateReason: "active_owner",
      });
    }
    if (waited === "cleanup_pending") {
      throw elwoodError(
        `${adapter}_update_failed`,
        "Another updater's process group has not exited.",
        { updateReason: "cleanup_pending", cleanupErrorCode: "ETIMEDOUT" },
      );
    }
    recoveredStale = true;
  }
  if (
    !recoveredStale &&
    (observedActive || (await readOptionalText(completion)) !== priorCompletion)
  ) {
    await releaseLease(path, owner);
    return;
  }
  const outcome = await update().then(
    () => undefined,
    (error: unknown) => ({ error }),
  );
  // An aborted probe's unresolved group is observed once more: only a group still live
  // after that window keeps the lease, and then the lease outlives this process.
  const abortedGroupId = unresolvedProbeGroup(outcome?.error);
  const unfinishedGroupIds =
    abortedGroupId === undefined ? [] : await waitForProbeGroups([abortedGroupId]);
  if (unfinishedGroupIds.length === 0) {
    await Promise.allSettled([writeFile(completion, owner.token, { mode: 0o600 })]);
    await releaseLease(path, owner);
  } else {
    await retainLease(
      path,
      owner,
      unfinishedGroupIds,
      options.retainRetryMs ?? defaultRetainRetryMs,
    );
  }
  if (outcome !== undefined) throw outcome.error;
}

/**
 * Publishes the lease atomically: the owner record is written inside a private staging
 * directory that is then renamed into place, so no partial or ownerless lease is ever
 * published. A claimant killed before that rename leaves only its staging directory; one
 * killed after it leaves a complete lease naming a dead owner, which ordinary stale
 * recovery removes. `rename` refuses a non-empty destination, which is exactly an
 * existing lease.
 */
async function claimLease(path: string, owner: LeaseOwner): Promise<boolean> {
  // An existing lease, even an ownerless one left by an older version, is a wait condition:
  // `rename` would silently replace an empty directory instead of recovering it as stale.
  if ((await pathExists(recoveryPath(path))) || (await pathExists(path))) return false;
  const staging = `${path}.claim.${randomUUID()}`;
  try {
    await mkdir(staging, { mode: 0o700 });
    await writeFile(join(staging, ownerFile), serializeOwner(owner), { flag: "wx", mode: 0o600 });
    await rename(staging, path);
  } catch {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    return false;
  }
  if (await pathExists(recoveryPath(path))) {
    await releaseLease(path, owner);
    return false;
  }
  await sweepLeaseLeftovers(path);
  return true;
}

/**
 * Removes this adapter's lease leftovers, of which there are two kinds: `.claim.` staging
 * left by claimants killed before their publishing rename, and `.released.` directories left
 * by an owner whose retirement was renamed away but not deleted. Only the lease holder
 * sweeps: a live contender's staging can no longer win, and losing it merely turns that
 * contender's failed rename into a missing source. Both kinds share one budget — at most
 * `maxSweptLeftovers` removals from at most `maxInspectedEntries` entries read — so a pile of
 * debris delays no single update; later holders finish the job.
 */
async function sweepLeaseLeftovers(path: string): Promise<void> {
  const root = dirname(path);
  // Claim staging AND leases already retired by their owner: both are this adapter's debris.
  const leftovers = [".claim.", retiredLeaseInfix].map((infix) => `${basename(path)}${infix}`);
  let swept = 0;
  let inspected = 0;
  try {
    // Streamed and bounded in both deletions and entries read: the root is shared with the
    // other adapter, whose own lease holders sweep its leftovers.
    for await (const entry of await opendir(root)) {
      if (leftovers.some((prefix) => entry.name.startsWith(prefix))) {
        await rm(join(root, entry.name), { recursive: true, force: true }).catch(() => undefined);
        swept += 1;
        if (swept === maxSweptLeftovers) break;
      }
      // Counted after the entry is handled, so `maxInspectedEntries` is an upper bound that
      // is never overshot; a short root or the deletion budget above can stop the scan sooner.
      inspected += 1;
      if (inspected === maxInspectedEntries) break;
    }
  } catch {
    // Sweeping is housekeeping: an unreadable root must not stop the lease holder's update.
  }
}
