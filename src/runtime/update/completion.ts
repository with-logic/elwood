/** Pin completion snapshots and atomically publish generations (PRD §9.2, C-PERF-04). */
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode } from "../../core/errors.ts";
import { type LeaseOwner, pendingOwnerPrefix, readOwner } from "./owner.ts";

/** An unreadable marker is not proof that an update never completed. */
export async function readCompletionGeneration(markerPath: string): Promise<string | undefined> {
  try {
    return await readFile(markerPath, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** Opening first pins the baseline inode while subsequent owner and pathname reads interleave. */
export async function completionSnapshot(leasePath: string, markerPath: string) {
  const baseline = await open(markerPath, "r").catch((error: unknown) => {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  });
  try {
    const ownerGeneration = (await readOwner(leasePath))?.token;
    const priorCompletionGeneration = await baseline?.readFile("utf8");
    // Keep this pathname observation before claiming: an observed owner may retire meanwhile.
    const visibleCompletionGeneration = await readCompletionGeneration(markerPath);
    return {
      ownerGeneration,
      priorCompletionGeneration,
      ownerAlreadyCompleted:
        ownerGeneration !== undefined && visibleCompletionGeneration === ownerGeneration,
    } as const;
  } finally {
    await baseline?.close();
  }
}

/** Never overwrite a pinned marker inode; interrupted staging is owned by the existing lease. */
export async function publishCompletionGeneration(
  leasePath: string,
  markerPath: string,
  owner: LeaseOwner,
): Promise<void> {
  const staging = join(leasePath, `${pendingOwnerPrefix}${owner.token}.completed`);
  try {
    await writeFile(staging, owner.token, { flag: "wx", mode: 0o600 });
    await rename(staging, markerPath);
  } finally {
    await unlink(staging).catch(() => undefined);
  }
}
