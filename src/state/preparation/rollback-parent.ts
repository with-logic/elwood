/** Trust rollback lookup parents using the existing mode/owner policy (PRD §8.1, C-STATE-14). */
import { dirname } from "node:path";
import { ElwoodError, errnoCode } from "../../core/errors.ts";
import { assertTrustedIgnoreParent } from "./root-trust.ts";

/** Preserve entries when another account can redirect lookup, or the parent is missing. */
export function trustedRollbackParent(path: string): boolean {
  try {
    assertTrustedIgnoreParent(dirname(path));
    return true;
  } catch (error) {
    if (
      errnoCode(error) === "ENOENT" ||
      (error instanceof ElwoodError && error.code === "state_corrupt")
    )
      return false;
    throw error;
  }
}
