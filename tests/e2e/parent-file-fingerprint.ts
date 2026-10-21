/** Compare parent-owned files without exposing contents (PRD §12 private proofs). */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export function parentFileFingerprint(path: string): string {
  return existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex")
    : "absent";
}
