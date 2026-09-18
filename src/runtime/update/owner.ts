/**
 * Update lease owner records: identity, liveness, and generation-checked release.
 * Implements PRD §9.2 / C-PERF-04: cleanup removes only the generation it owns.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode } from "../../core/errors.ts";
import { processGroupGone } from "../probe-cleanup.ts";

export const ownerFile = "owner";
/** Marks a lease directory already retired by its owner and awaiting deletion. */
export const retiredLeaseInfix = ".released.";
/** Prefix of a record being written but not yet committed into the lease. */
export const pendingOwnerPrefix = "owner.next.";
const ownerPattern = /^(\d+):([0-9a-f-]+)(?::(\d+(?:,\d+)*))?$/;
export type LeaseOwner = {
  readonly pid: number;
  readonly token: string;
  /** Updater process groups that outlived the update callback and still hold the lease. */
  readonly ownedProcessGroupIds?: readonly number[];
};

/** File contents, or undefined when absent/unreadable (never throws). */
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
  const ownedProcessGroupIds = match[3]?.split(",").map(Number);
  // An identity no signal probe can evaluate is malformed, not live; like any unreadable
  // record it fails safe rather than reaching process.kill.
  if (![pid, ...(ownedProcessGroupIds ?? [])].every(isProcessId)) return undefined;
  return {
    pid,
    token: match[2] as string,
    ...(ownedProcessGroupIds === undefined ? {} : { ownedProcessGroupIds }),
  };
}

export function serializeOwner(owner: LeaseOwner): string {
  const groups =
    owner.ownedProcessGroupIds === undefined ? "" : `:${owner.ownedProcessGroupIds.join(",")}`;
  return `${owner.pid}:${owner.token}${groups}`;
}

/**
 * Lease liveness, not owner-process liveness. A record naming process groups is held by
 * those groups alone, so it ends with them rather than with the process that wrote it —
 * that is what lets an update's surviving children keep the lease past their parent. No
 * record names groups until something records them, so this is `parentIsAlive` until then.
 */
export function leaseIsAlive(owner: LeaseOwner): boolean {
  if (owner.ownedProcessGroupIds === undefined) return parentIsAlive(owner.pid);
  return owner.ownedProcessGroupIds.some((id) => !processGroupGone(id));
}

export function parentIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) !== "ESRCH";
  }
}

/**
 * Replaces this generation's owner record, naming the process groups that now hold the
 * lease. The write lands on a per-write temporary name and is committed by rename, so a
 * late or concurrent write can neither clobber nor unlink another write's pending record,
 * and a write that outlives its lease cannot replace a successor generation's record.
 */
export async function retainProbeOwner(
  path: string,
  owner: LeaseOwner,
  processGroupIds: readonly number[],
): Promise<void> {
  const temporary = join(path, `${pendingOwnerPrefix}${randomUUID()}`);
  try {
    const record = { ...owner, ownedProcessGroupIds: processGroupIds };
    await writeFile(temporary, serializeOwner(record), { mode: 0o600 });
    if ((await readOwner(path))?.token !== owner.token)
      throw new Error("The update lease belongs to another generation.");
    await rename(temporary, join(path, ownerFile));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Retires the lease atomically by renaming it away before deleting it. Removing the record
 * and then the directory would expose an ownerless lease in between, which a polling
 * contender recovers as stale and follows with a duplicate update.
 *
 * A rename that fails outright must still not leave this owner's lease standing: the owner
 * is alive, so contenders would read a live pid and wait for an update that already
 * finished — forever, on that host. The fallback removes the lease where it is instead,
 * which briefly exposes the ownerless window for that one release. That is the lesser of
 * the two: a duplicate update is recoverable, an update no one can ever run is not.
 */
export async function releaseLease(path: string, owner: LeaseOwner): Promise<void> {
  const current = await readOwner(path);
  if (current?.token !== owner.token) return;
  const retired = `${path}${retiredLeaseInfix}${owner.token}`;
  const renamed = await rename(path, retired).then(
    () => true,
    () => false,
  );
  // One recursive removal either way: of the retired copy when the rename worked, or of the
  // lease in place when it did not. Removing the directory takes the owner record with it.
  await rm(renamed ? retired : path, { recursive: true, force: true }).catch(() => undefined);
}
