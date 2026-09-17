/**
 * Update lease owner records: identity, liveness, and generation-checked release.
 * Implements PRD §9.2 / C-PERF-04: cleanup removes only the generation it owns.
 */
import { readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode } from "../../core/errors.ts";

export const ownerFile = "owner";
/** Marks a lease directory already retired by its owner and awaiting deletion. */
export const retiredLeaseInfix = ".released.";
export type LeaseOwner = { readonly pid: number; readonly token: string };

/** File contents, or undefined when absent/unreadable (never throws). */
export async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function readOwner(path: string): Promise<LeaseOwner | undefined> {
  const match = /^(\d+):([0-9a-f-]+)$/.exec((await readOptionalText(join(path, ownerFile))) ?? "");
  return match ? { pid: Number(match[1]), token: match[2] as string } : undefined;
}

export function serializeOwner(owner: LeaseOwner): string {
  return `${owner.pid}:${owner.token}`;
}

export function ownerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) !== "ESRCH";
  }
}

/**
 * Retires the lease atomically by renaming it away before deleting it. Removing the record
 * and then the directory would expose an ownerless lease in between, which a polling
 * contender recovers as stale and follows with a duplicate update.
 */
export async function releaseLease(path: string, owner: LeaseOwner): Promise<void> {
  const current = await readOwner(path);
  if (current?.token !== owner.token) return;
  const retired = `${path}${retiredLeaseInfix}${owner.token}`;
  const renamed = await rename(path, retired).then(
    () => true,
    () => false,
  );
  if (renamed) await rm(retired, { recursive: true, force: true }).catch(() => undefined);
}
