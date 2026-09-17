/**
 * Cross-process lease for globally mutating agent updates.
 * Implements PRD §9.2, C-LIFE-09, and C-PERF-04: separate Elwood hosts for
 * one macOS user serialize per-adapter updates and recover a killed owner's lease.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, rmdir, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  type LeaseOwner,
  ownerFile,
  readOptionalText,
  releaseLease,
  serializeOwner,
} from "./owner.ts";
import { pathExists, recoveryPath, waitForOwner } from "./waiting.ts";

export type UpdateAdapter = "claude" | "codex";

export type UpdateLeaseOptions = {
  readonly root?: string;
  readonly pollMs?: number;
  readonly staleMs?: number;
};

const defaultPollMs = 50;
const defaultStaleMs = 30_000;

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
    const waited = await waitForOwner(path, pollMs, staleMs);
    if (waited === "released") return;
    recoveredStale = true;
  }
  if (
    !recoveredStale &&
    (observedActive || (await readOptionalText(completion)) !== priorCompletion)
  ) {
    await releaseLease(path, owner);
    return;
  }
  try {
    await update();
  } finally {
    await Promise.allSettled([writeFile(completion, owner.token, { mode: 0o600 })]);
    await releaseLease(path, owner);
  }
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
