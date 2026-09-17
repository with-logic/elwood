/**
 * Update lease identities and durable ownership of unresolved probe groups.
 * Implements PRD §9.2 / C-PERF-04: a surviving updater cannot overlap a successor.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ElwoodError, errnoCode } from "../../core/errors.ts";
import { processGroupGone } from "../probe-cleanup.ts";

export const ownerFile = "owner";
export const pendingOwnerPrefix = "owner.next.";
const ownerPattern = /^(\d+):([0-9a-f-]+)(?::(\d+(?:,\d+)*)(:active)?)?$/;
export type LeaseOwner = {
  readonly pid: number;
  readonly token: string;
  readonly cleanupGroups?: readonly number[];
  /** The live parent's update callback, not any one probe, still owns the lease. */
  readonly callbackOwnsLease?: boolean;
};

export async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

const isProcessId = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

export async function readOwner(path: string): Promise<LeaseOwner | undefined> {
  const match = ownerPattern.exec((await readOptionalText(join(path, ownerFile))) ?? "");
  if (!match) return undefined;
  const pid = Number(match[1]);
  const cleanupGroups = match[3]?.split(",").map(Number);
  // An identity no signal probe can evaluate is malformed, not live; like any
  // unreadable record it fails safe rather than reaching process.kill.
  if (![pid, ...(cleanupGroups ?? [])].every(isProcessId)) return undefined;
  return {
    pid,
    token: match[2]!,
    ...(cleanupGroups === undefined
      ? {}
      : { cleanupGroups, callbackOwnsLease: match[4] !== undefined }),
  };
}

export function serializeOwner(owner: LeaseOwner): string {
  const groups =
    owner.cleanupGroups === undefined
      ? ""
      : `:${owner.cleanupGroups.join(",")}${owner.callbackOwnsLease ? ":active" : ""}`;
  return `${owner.pid}:${owner.token}${groups}`;
}

/** Lease liveness, not owner-process liveness: a surviving group outlives its parent. */
export function leaseIsAlive(owner: LeaseOwner): boolean {
  const groupAlive = owner.cleanupGroups?.some((id) => !processGroupGone(id)) ?? false;
  // A live parent owns the whole callback, including gaps between version and
  // update probes. Cleanup-marked records instead use group-only liveness.
  if (owner.cleanupGroups !== undefined && !owner.callbackOwnsLease) return groupAlive;
  return parentIsAlive(owner.pid) || groupAlive;
}

export function parentIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) !== "ESRCH";
  }
}

export function unresolvedProbeGroup(error: unknown): number | undefined {
  const group = error instanceof ElwoodError ? error.details["cleanupProcessGroup"] : undefined;
  return typeof group === "number" && Number.isSafeInteger(group) && group > 0 ? group : undefined;
}

export async function retainProbeOwner(
  path: string,
  owner: LeaseOwner,
  processGroupIds: readonly number[],
  signal?: AbortSignal,
): Promise<void> {
  // A per-write name: a late or concurrent write can neither clobber nor unlink
  // another write's pending record, including a successor generation's.
  const temporary = join(path, `${pendingOwnerPrefix}${randomUUID()}`);
  try {
    const record = { ...owner, cleanupGroups: processGroupIds, callbackOwnsLease: !!signal };
    await writeFile(temporary, serializeOwner(record), { mode: 0o600 });
    if (signal?.aborted) {
      await unlink(temporary);
      return;
    }
    // Commit only into this generation. A write outliving its lease must not
    // replace a successor's record, and its probe gate must stay closed.
    if ((await readOwner(path))?.token !== owner.token)
      throw new Error("The update lease belongs to another generation.");
    await rename(temporary, join(path, ownerFile));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function releaseLease(path: string, owner: LeaseOwner): Promise<void> {
  const current = await readOwner(path);
  if (current?.token !== owner.token) return;
  await unlink(join(path, ownerFile)).catch(() => undefined);
  await rmdir(path).catch(() => undefined);
}
