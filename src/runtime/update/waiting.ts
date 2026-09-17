/**
 * Update contention and generation-safe recovery of a dead owner's lease.
 * Implements PRD §9.2 / C-PERF-04. Time alone never evicts an owner known to be live;
 * only a lease whose record is unreadable is presumed abandoned, after 24 hours untouched.
 */
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
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
    let lease: Stats;
    try {
      lease = await stat(path);
    } catch {
      if (await restoreRecovery(path)) continue;
      return "released";
    }
    const untouchedMs = Date.now() - lease.mtimeMs;
    if (untouchedMs >= staleMs) {
      const abandoned = untouchedMs >= abandonedLeaseMs ? lease : undefined;
      const recovered = await recoverStaleLease(path, abandoned);
      if (recovered === "removed") return "stale_removed";
      if (recovered === "unrecoverable") return "released";
    }
    await delay(pollMs);
  }
}

async function recoverStaleLease(
  path: string,
  abandoned: Stats | undefined,
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
    // An unreadable record may belong to a live updater writing a format this version
    // cannot read, so it stays in place and keeps failing safe until the lease is abandoned.
    if (moved === undefined && abandoned !== undefined) {
      await discardAbandoned(recovery, abandoned);
      return "removed";
    }
    if (moved !== undefined) await unlink(join(recovery, ownerFile));
    await rmdir(recovery);
    return "removed";
  } catch {
    return "unrecoverable";
  }
}

/**
 * An unreadable record carries no token, so the directory itself is the generation: the
 * one judged abandoned is identified by inode and birth time. The cleaner first takes the
 * recovered directory under a private name, where nothing else can replace it, and deletes
 * it only if it is that directory. Anything else reached the shared recovery path while
 * this cleaner was paused; it is handed back untouched and recovery fails safe.
 */
async function discardAbandoned(recovery: string, abandoned: Stats): Promise<void> {
  const taken = `${recovery}.${randomUUID()}`;
  await rename(recovery, taken);
  const held = await stat(taken);
  if (held.ino === abandoned.ino && held.birthtimeMs === abandoned.birthtimeMs)
    return rm(taken, { recursive: true, force: true });
  await rename(taken, recovery);
  throw new Error("The recovered lease is another generation.");
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
