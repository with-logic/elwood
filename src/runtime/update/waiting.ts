/**
 * Update contention and generation-safe recovery of a dead owner's lease.
 * Implements PRD §9.2 / C-PERF-04; time alone never evicts a live updater.
 */
import { rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ownerFile, ownerIsAlive, readOwner } from "./owner.ts";

// Far beyond any bounded update: an unreadable lease untouched this long has no live owner.
const abandonedLeaseMs = 24 * 60 * 60 * 1_000;

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
    const untouchedMs = Date.now() - lease.mtimeMs;
    if (untouchedMs >= staleMs) {
      const recovered = await recoverStaleLease(path, untouchedMs >= abandonedLeaseMs);
      if (recovered === "removed") return "stale_removed";
      if (recovered === "unrecoverable") return "released";
    }
    await delay(pollMs);
  }
}

async function recoverStaleLease(
  path: string,
  abandoned: boolean,
): Promise<"removed" | "alive" | "unrecoverable"> {
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
    // An unreadable record may belong to a live updater writing a format this version
    // cannot read, so it stays in place and keeps failing safe until the lease is abandoned.
    else if (abandoned) await rm(join(recovery, ownerFile), { force: true });
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
