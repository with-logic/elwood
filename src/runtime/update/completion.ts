/** Pin completion evidence and atomically publish affirmative attempts (PRD §9.2, C-PERF-04). */
import { type FileHandle, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sameDirectoryIdentity } from "../../core/directory-identity.ts";
import { errnoCode } from "../../core/errors.ts";
import { type LeaseOwner, pendingOwnerPrefix, readOwner } from "./owner.ts";

const affirmativeAttemptPrefix = "elwood-update-attempt-v1:";
export type PeerCompletionEvidence = "none" | "confirmed" | "unconfirmed";

export function completionReceiptPath(markerPath: string): string {
  return `${markerPath}.attempted`;
}

export function serializeCompletionReceipt(generation: string): string {
  return `${affirmativeAttemptPrefix}${generation}`;
}

/** A companion alone does not confirm completion; its generation must match the raw token. */
function confirmedReceiptGeneration(marker: string | undefined): string | undefined {
  return marker?.startsWith(affirmativeAttemptPrefix)
    ? marker.slice(affirmativeAttemptPrefix.length) || undefined
    : undefined;
}

/** Relevance precedes interpretation: unchanged historical legacy markers are not peers. */
export async function observePeerCompletion(
  snapshot: Awaited<ReturnType<typeof completionSnapshot>>,
  observed: ReadonlySet<string>,
  markerPath: string,
): Promise<PeerCompletionEvidence> {
  const current = await readCompletionGeneration(markerPath);
  const receipt = await readCompletionGeneration(completionReceiptPath(markerPath));
  const generation = confirmedReceiptGeneration(receipt);
  const changed =
    current !== snapshot.priorCompletionGeneration || receipt !== snapshot.priorCompletionReceipt;
  const observedOwner =
    (current !== undefined && observed.has(current)) ||
    (generation !== undefined && observed.has(generation));
  if (
    snapshot.ownerAlreadyCompleted ||
    (generation !== undefined && generation === current && (observedOwner || changed))
  )
    return "confirmed";
  if (
    snapshot.mismatchedReceipt !== undefined ||
    snapshot.ownerCompletionUnconfirmed ||
    changed ||
    observedOwner
  )
    return "unconfirmed";
  return "none";
}

/** Unreadable evidence is not proof that an update never completed. */
export async function readCompletionGeneration(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** Pin both baselines before observing the owner; new publication replaces their inodes. */
export async function completionSnapshot(leasePath: string, markerPath: string) {
  const baseline = await openOptional(markerPath);
  let receiptBaseline: FileHandle | undefined;
  try {
    const receiptPath = completionReceiptPath(markerPath);
    receiptBaseline = await openOptional(receiptPath);
    const ownerGeneration = (await readOwner(leasePath))?.token;
    const priorCompletionGeneration = await baseline?.readFile("utf8");
    const priorCompletionReceipt = await receiptBaseline?.readFile("utf8");
    const priorReceiptGeneration = confirmedReceiptGeneration(priorCompletionReceipt);
    const mismatchedReceipt =
      receiptBaseline !== undefined &&
      priorReceiptGeneration !== undefined &&
      priorReceiptGeneration !== priorCompletionGeneration
        ? ({
            generation: priorReceiptGeneration,
            contents: priorCompletionReceipt,
            identity: await receiptBaseline.stat({ bigint: true }),
          } as const)
        : undefined;
    const visibleCompletionGeneration = await readCompletionGeneration(markerPath);
    const visibleReceipt = confirmedReceiptGeneration(await readCompletionGeneration(receiptPath));
    const ownerAlreadyCompleted =
      ownerGeneration !== undefined &&
      visibleCompletionGeneration === ownerGeneration &&
      visibleReceipt === ownerGeneration;
    return {
      ownerGeneration,
      priorCompletionGeneration,
      priorCompletionReceipt,
      mismatchedReceipt,
      ownerAlreadyCompleted,
      ownerCompletionUnconfirmed:
        ownerGeneration !== undefined &&
        !ownerAlreadyCompleted &&
        (visibleCompletionGeneration === ownerGeneration || visibleReceipt === ownerGeneration),
    } as const;
  } finally {
    try {
      await baseline?.close();
    } finally {
      await receiptBaseline?.close();
    }
  }
}

/** Consume only unchanged captured evidence while owning the lease; keep current waiters excluded. */
export async function consumeMismatchedReceipt(
  snapshot: Awaited<ReturnType<typeof completionSnapshot>>,
  markerPath: string,
  leasePath: string,
  owner: LeaseOwner,
): Promise<void> {
  const mismatch = snapshot.mismatchedReceipt;
  if (mismatch === undefined || (await readOwner(leasePath))?.token !== owner.token) return;
  const receiptPath = completionReceiptPath(markerPath);
  const receipt = await openOptional(receiptPath);
  try {
    if (receipt === undefined) return;
    const identity = await receipt.stat({ bigint: true });
    if (!sameDirectoryIdentity(identity, mismatch.identity)) return;
    if ((await receipt.readFile("utf8")) !== mismatch.contents) return;
    if ((await readCompletionGeneration(markerPath)) === mismatch.generation) return;
    // Promotion truthfully names the affirmed attempt, and changes every earlier raw baseline.
    await publishMarker(leasePath, markerPath, owner, "acknowledged", mismatch.generation);
    await unlink(receiptPath);
  } finally {
    await receipt?.close();
  }
}

function openOptional(path: string): Promise<FileHandle | undefined> {
  return open(path, "r").catch((error: unknown) => {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  });
}

/** Publish affirmative companion first and legacy raw UUID last, preserving old readers. */
export async function publishCompletionGeneration(
  leasePath: string,
  markerPath: string,
  owner: LeaseOwner,
): Promise<void> {
  await publishMarker(
    leasePath,
    completionReceiptPath(markerPath),
    owner,
    "attempted",
    serializeCompletionReceipt(owner.token),
  );
  await publishMarker(leasePath, markerPath, owner, "completed", owner.token);
}

/** Interrupted staging is owned by the lease; no publication overwrites a pinned inode. */
async function publishMarker(
  leasePath: string,
  markerPath: string,
  owner: LeaseOwner,
  suffix: string,
  contents: string,
): Promise<void> {
  const staging = join(leasePath, `${pendingOwnerPrefix}${owner.token}.${suffix}`);
  try {
    await writeFile(staging, contents, { flag: "wx", mode: 0o600 });
    await rename(staging, markerPath);
  } finally {
    await unlink(staging).catch(() => undefined);
  }
}
