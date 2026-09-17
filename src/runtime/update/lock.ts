/**
 * Cross-process lease for globally mutating agent updates.
 * Implements PRD §9.2, C-LIFE-09, and C-PERF-04: separate Elwood hosts for
 * one macOS user serialize per-adapter updates and recover a killed owner's lease.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { errnoCode } from "../../core/errors.ts";

export type UpdateAdapter = "claude" | "codex";

export type UpdateLeaseOptions = {
  readonly root?: string;
  readonly pollMs?: number;
  readonly staleMs?: number;
};

const defaultPollMs = 50;
const defaultStaleMs = 30_000;
const ownerFile = "owner";
type LeaseOwner = { readonly pid: number; readonly token: string };

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
  const priorCompletion = await readCompletion(completion);
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
    (observedActive || (await readCompletion(completion)) !== priorCompletion)
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

async function waitForOwner(
  path: string,
  pollMs: number,
  staleMs: number,
): Promise<"released" | "stale_removed"> {
  for (;;) {
    let lease: Awaited<ReturnType<typeof stat>>;
    try {
      lease = await stat(path);
    } catch {
      if (await restoreRecovery(path)) continue;
      return "released";
    }
    if (Date.now() - lease.mtimeMs >= staleMs) {
      const recovered = await recoverStaleLease(path);
      if (recovered === "removed") return "stale_removed";
      if (recovered === "unrecoverable") return "released";
    }
    await delay(pollMs);
  }
}

async function recoverStaleLease(path: string): Promise<"removed" | "alive" | "unrecoverable"> {
  const expected = await readOwner(path);
  if (expected !== undefined && ownerIsAlive(expected.pid)) return "alive";
  const recovery = recoveryPath(path);
  try {
    await rename(path, recovery);
  } catch {
    return (await pathExists(recovery)) ? "alive" : "unrecoverable";
  }
  const moved = await readOwner(recovery);
  if (expected?.token !== moved?.token || (moved !== undefined && ownerIsAlive(moved.pid))) {
    return "unrecoverable";
  }
  try {
    if (moved !== undefined) await unlink(join(recovery, ownerFile));
    await rmdir(recovery);
    return "removed";
  } catch {
    return "unrecoverable";
  }
}

async function restoreRecovery(path: string): Promise<boolean> {
  try {
    await rename(recoveryPath(path), path);
    return true;
  } catch {
    return pathExists(path);
  }
}

function recoveryPath(path: string): string {
  return `${path}.recovery`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function releaseLease(path: string, owner: LeaseOwner): Promise<void> {
  const current = await readOwner(path);
  if (current?.token !== owner.token) return;
  await unlink(join(path, ownerFile)).catch(() => undefined);
  await rmdir(path).catch(() => undefined);
}

/** File contents, or undefined when absent/unreadable (never throws). */
async function readCompletion(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function readOwner(path: string): Promise<LeaseOwner | undefined> {
  const match = /^(\d+):([0-9a-f-]+)$/.exec((await readCompletion(join(path, ownerFile))) ?? "");
  return match ? { pid: Number(match[1]), token: match[2] as string } : undefined;
}

function serializeOwner(owner: LeaseOwner): string {
  return `${owner.pid}:${owner.token}`;
}

function ownerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) !== "ESRCH";
  }
}
