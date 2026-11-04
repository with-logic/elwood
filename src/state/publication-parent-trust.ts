/** Reject other-user replaceable publication ancestry (PRD §8.1, C-STATE-01). */
import { dirname } from "node:path";
import { ElwoodError, elwoodError, errnoCode } from "../core/errors.ts";
import { assertTrustedIgnoreParent } from "./preparation/root-trust.ts";

/** Inspect existing ancestors; normal publication still decides how missing parents fail. */
export function assertTrustedPublicationParent(path: string): void {
  try {
    assertTrustedIgnoreParent(dirname(path));
  } catch (error) {
    if (error instanceof ElwoodError)
      throw elwoodError(
        "state_corrupt",
        `${error.message} Use a private, current-user-owned stateDir or remove shared-write permissions from its ancestors.`,
        { cause: error.message },
      );
    // The root-first walk checked every existing ancestor before reaching the absent entry.
    if (errnoCode(error) !== "ENOENT") throw error;
  }
}
