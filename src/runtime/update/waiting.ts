/**
 * Update contention and generation-safe recovery of a dead owner's lease.
 * Implements PRD §9.2 / C-PERF-04; time alone never evicts a live updater.
 */
import { readdir, rename, rmdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { leaseIsAlive, ownerFile, pendingOwnerPrefix, readOwner } from "./owner.ts";

export async function waitForOwner(
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
    // A record being written when its owner died is named uniquely and commits by rename,
    // so any left here belongs to this dead generation and would otherwise block `rmdir`.
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
