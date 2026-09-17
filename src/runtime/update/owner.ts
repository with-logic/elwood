/**
 * Update lease identities and durable ownership of unresolved probe groups.
 * Implements PRD §9.2 / C-PERF-04: a surviving updater cannot overlap a successor.
 */
import { readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ElwoodError, errnoCode } from "../../core/errors.ts";
import { processGroupGone } from "../probe-cleanup.ts";

export const ownerFile = "owner";
export type LeaseOwner = {
  readonly pid: number;
  readonly token: string;
  readonly cleanupGroup?: number;
  readonly activeProbe?: boolean;
};

export async function readCompletion(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function readOwner(path: string): Promise<LeaseOwner | undefined> {
  const match = /^(\d+):([0-9a-f-]+)(?::(\d+)(:active)?)?$/.exec(
    (await readCompletion(join(path, ownerFile))) ?? "",
  );
  return match
    ? {
        pid: Number(match[1]),
        token: match[2]!,
        ...(match[3] === undefined
          ? {}
          : { cleanupGroup: Number(match[3]), activeProbe: match[4] !== undefined }),
      }
    : undefined;
}

export function serializeOwner(owner: LeaseOwner): string {
  return `${owner.pid}:${owner.token}${owner.cleanupGroup === undefined ? "" : `:${owner.cleanupGroup}${owner.activeProbe ? ":active" : ""}`}`;
}

export function ownerIsAlive(owner: LeaseOwner): boolean {
  if (owner.cleanupGroup !== undefined && !owner.activeProbe)
    return !processGroupGone(owner.cleanupGroup);
  if (parentIsAlive(owner.pid)) return true;
  return owner.cleanupGroup !== undefined && !processGroupGone(owner.cleanupGroup);
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
  group: number,
  signal?: AbortSignal,
): Promise<void> {
  const temporary = join(path, "owner.next");
  try {
    await writeFile(
      temporary,
      serializeOwner({ ...owner, cleanupGroup: group, activeProbe: signal !== undefined }),
      { mode: 0o600 },
    );
    if (signal?.aborted) {
      await unlink(temporary);
      return;
    }
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
