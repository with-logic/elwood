/**
 * Cross-process lease for globally mutating agent updates.
 * Implements PRD §9.2, C-LIFE-09, and C-PERF-04: separate Elwood hosts for
 * one macOS user serialize per-adapter updates and recover a killed owner's lease.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, rmdir, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { ElwoodError, elwoodError } from "../../core/errors.ts";
import {
  type LeaseOwner,
  ownerFile,
  readOptionalText,
  releaseLease,
  retainProbeOwner,
  serializeOwner,
  unresolvedProbeGroup,
} from "./owner.ts";
import { ProbeRegistration } from "./probe-registration.ts";
import { pathExists, recoveryPath, waitForOwner } from "./waiting.ts";

export type UpdateAdapter = "claude" | "codex";

export type UpdateLeaseOptions = {
  readonly root?: string;
  readonly pollMs?: number;
  readonly staleMs?: number;
  readonly waitMs?: number;
};

const defaultPollMs = 50;
const defaultStaleMs = 30_000;
const defaultWaitMs = 60_000;

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
 * After 60 seconds by default, an active/unconfirmed owner rejects with the adapter's
 * update_failed error and cleanupErrorCode ETIMEDOUT; preflight warns and continues.
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
  const deadline = Date.now() + (options.waitMs ?? defaultWaitMs);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const owner = { pid: process.pid, token: randomUUID() } satisfies LeaseOwner;
  const completion = join(root, `${adapter}.completed`);
  const priorCompletion = await readOptionalText(completion);
  let observedActive = (await pathExists(path)) || (await pathExists(recoveryPath(path)));
  let recoveredStale = false;
  while (!(await claimLease(path, owner))) {
    // Losing the claim IS an observation of an active owner. Sampling only before
    // the loop misses a peer that claimed in the interim, and that contender would
    // then treat its own later claim as the first attempt and run a duplicate
    // update (PRD §9.2: a contender skips its duplicate attempt).
    observedActive = true;
    const waited = await waitForOwner(path, pollMs, staleMs, deadline);
    if (waited === "released") return;
    if (waited === "cleanup_pending") {
      throw elwoodError(
        `${adapter}_update_failed`,
        "Another updater has not finished or confirmed cleanup.",
        {
          cleanupErrorCode: "ETIMEDOUT",
          updateReason: "active_owner",
        },
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
  const probes = new ProbeRegistration((groups, signal) =>
    retainProbeOwner(path, owner, groups, signal),
  );
  const outcome = await probes.run(update).then(
    () => undefined,
    (error: unknown) => ({ error }),
  );
  // Success and failure alike: a probe that exited on its own, zero or not, may
  // have left updater descendants in any group this callback registered.
  const aborted = unresolvedProbeGroup(outcome?.error);
  const unfinished = [
    ...new Set([...(aborted === undefined ? [] : [aborted]), ...(await probes.unfinishedGroups())]),
  ];
  const [group] = unfinished;
  if (group === undefined) {
    await probes.releaseWhenRegistrationsSettle(async () => {
      await Promise.allSettled([writeFile(completion, owner.token, { mode: 0o600 })]);
      await releaseLease(path, owner);
    });
    if (outcome !== undefined) throw outcome.error;
    return;
  }
  // The active groups were already persisted before exec. If marking cleanup
  // fails, retain that record and preserve the original typed diagnostics.
  await retainProbeOwner(path, owner, unfinished).catch(() => undefined);
  throw unconfirmedCleanup(adapter, outcome, group);
}

function unconfirmedCleanup(
  adapter: UpdateAdapter,
  outcome: { readonly error: unknown } | undefined,
  group: number,
): unknown {
  const cleanup = { cleanupErrorCode: "ETIMEDOUT", cleanupProcessGroup: group };
  if (outcome === undefined)
    return elwoodError(`${adapter}_update_failed`, "Updater descendants have not exited.", cleanup);
  const { error } = outcome;
  if (!(error instanceof ElwoodError) || unresolvedProbeGroup(error) !== undefined) return error;
  return elwoodError(error.code, error.message, { ...error.details, ...cleanup });
}

async function claimLease(path: string, owner: LeaseOwner): Promise<boolean> {
  if (await pathExists(recoveryPath(path))) return false;
  try {
    await mkdir(path, { mode: 0o700 });
  } catch {
    return false;
  }
  try {
    await writeFile(join(path, ownerFile), serializeOwner(owner), { flag: "wx", mode: 0o600 });
    if (await pathExists(recoveryPath(path))) {
      await releaseLease(path, owner);
      return false;
    }
    return true;
  } catch {
    await rmdir(path).catch(() => undefined);
    return false;
  }
}
