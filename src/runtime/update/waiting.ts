/**
 * Bounded update contention and generation-safe recovery.
 * Implements PRD §9.2 / C-PERF-04; time alone never evicts a live updater.
 */
import { readdir, rename, rmdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type LeaseOwner,
  leaseIsAlive,
  ownerFile,
  parentIsAlive,
  pendingOwnerPrefix,
  readOwner,
} from "./owner.ts";

export async function waitForOwner(
  path: string,
  pollMs: number,
  staleMs: number,
  deadline: number,
): Promise<"released" | "stale_removed" | "cleanup_pending"> {
  for (;;) {
    if (Date.now() >= deadline) return "cleanup_pending";
    let lease: Awaited<ReturnType<typeof stat>>;
    try {
      lease = await stat(path);
    } catch {
      if (await restoreRecovery(path)) continue;
      return "released";
    }
    const current = await readOwner(path);
    const groupOwner = current?.cleanupGroups !== undefined;
    if (cleanupPending(current)) return "cleanup_pending";
    if ((groupOwner && !leaseIsAlive(current)) || Date.now() - lease.mtimeMs >= staleMs) {
      const recovered = await recoverStaleLease(path);
      if (recovered === "removed") return "stale_removed";
      if (recovered === "unrecoverable") return "released";
    }
    await delay(pollMs);
  }
}

function cleanupPending(owner: LeaseOwner | undefined): boolean {
  return (
    owner?.cleanupGroups !== undefined &&
    !(owner.callbackOwnsLease && parentIsAlive(owner.pid)) &&
    leaseIsAlive(owner)
  );
}

async function recoverStaleLease(path: string): Promise<"removed" | "alive" | "unrecoverable"> {
  const expected = await readOwner(path);
  if (expected !== undefined && leaseIsAlive(expected)) return "alive";
  const recovery = recoveryPath(path);
  try {
    await rename(path, recovery);
  } catch {
    return (await pathExists(recovery)) ? "alive" : "unrecoverable";
  }
  const moved = await readOwner(recovery);
  if (expected?.token !== moved?.token || (moved !== undefined && leaseIsAlive(moved))) {
    return "unrecoverable";
  }
  try {
    if (moved !== undefined) await unlink(join(recovery, ownerFile));
    // Late writers name their pending records uniquely; a malformed owner record
    // is deliberately left in place so an unreadable lease keeps failing safe.
    for (const entry of await readdir(recovery))
      if (entry.startsWith(pendingOwnerPrefix)) await unlink(join(recovery, entry));
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

export function recoveryPath(path: string): string {
  return `${path}.recovery`;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
