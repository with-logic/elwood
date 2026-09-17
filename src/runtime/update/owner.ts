/**
 * Update lease owner records: identity, liveness, and generation-checked release.
 * Implements PRD §9.2 / C-PERF-04: cleanup removes only the generation it owns.
 */
import { readFile, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode } from "../../core/errors.ts";

export const ownerFile = "owner";
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

export async function releaseLease(path: string, owner: LeaseOwner): Promise<void> {
  const current = await readOwner(path);
  if (current?.token !== owner.token) return;
  await unlink(join(path, ownerFile)).catch(() => undefined);
  await rmdir(path).catch(() => undefined);
}
