/** Bounded identity keys for Claude prompt evidence (PRD §5.4, C-API-62, C-API-63). */
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { maxIdentifierBytes, maxPathBytes } from "./turn-identity.ts";

/** At most this many prompt identities are remembered (PRD §5.4). */
export const maxPromptEntries = 64;

/** A fixed-size digest keeps prompt history bounded however large a prompt is. */
export function textDigest(text: string): string {
  return createHash("sha256").update(text).digest("base64");
}

export function turnDigestKey(turnId: string, digest: string): string {
  return JSON.stringify([turnId, digest]);
}

export function addBounded(set: Set<string>, value: string): void {
  set.add(value);
  if (set.size > maxPromptEntries) set.delete(set.values().next().value!);
}

export function promptLocation(path: string | undefined, turnId: string) {
  return path !== undefined &&
    isAbsolute(path) &&
    Buffer.byteLength(path) <= maxPathBytes &&
    Buffer.byteLength(turnId) <= maxIdentifierBytes
    ? { path, key: JSON.stringify([path, turnId]) }
    : undefined;
}
