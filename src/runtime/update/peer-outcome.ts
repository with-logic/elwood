/** Resolve peer evidence without converting uncertainty into retry authority (PRD §9.2). */
import { unconfirmedPeerUpdate } from "../../core/warnings/update-unconfirmed.ts";
import type { PeerCompletionEvidence } from "./completion.ts";
import type { UpdateAdapter } from "./lock.ts";
import { type LeaseOwner, releaseLease } from "./owner.ts";

/** Recovery may lose a retiring pathname after its owner already published completion. */
export function excludedPeerOutcome(
  adapter: UpdateAdapter,
  evidence: PeerCompletionEvidence,
): false {
  if (evidence !== "confirmed") throw unconfirmedPeerUpdate(adapter);
  return false;
}

/** A released peer permits retry only with its conclusive no-attempt receipt. */
export async function releasedPeerOutcome(
  adapter: UpdateAdapter,
  evidence: PeerCompletionEvidence,
  hasNoAttemptReceipt: () => Promise<boolean>,
): Promise<"retry" | false> {
  if (evidence === "confirmed") return false;
  if (evidence === "none" && (await hasNoAttemptReceipt())) return "retry";
  throw unconfirmedPeerUpdate(adapter);
}

/** An acquired lease is released on peer exclusion, including unreadable evidence. */
export async function confirmAcquiredLease(
  adapter: UpdateAdapter,
  leasePath: string,
  owner: LeaseOwner,
  readEvidence: () => Promise<PeerCompletionEvidence>,
  hasUnconfirmedActivePeer: () => Promise<boolean>,
  consumeUnconfirmedEvidence: () => Promise<void>,
): Promise<boolean> {
  try {
    const evidence = await readEvidence();
    if (evidence === "none" && !(await hasUnconfirmedActivePeer())) return true;
    if (evidence !== "confirmed") {
      await consumeUnconfirmedEvidence().catch(() => undefined);
      throw unconfirmedPeerUpdate(adapter);
    }
  } catch (error) {
    await releaseLease(leasePath, owner);
    throw error;
  }
  await releaseLease(leasePath, owner);
  return false;
}
