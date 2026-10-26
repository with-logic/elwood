/**
 * The CLI's diagnostic for a failed session cleanup (PRD §12A.2, C-CLI-09): it names the
 * typed Elwood failures behind it, each by its error code and errno token, and never
 * carries their messages, paths, or other free text.
 */

import { ElwoodError } from "../../core/errors.ts";
import type { TeardownFailure } from "../../runtime/shutdown/teardown.ts";

// An errno-shaped token (`EPERM`, `ETIMEDOUT`): fixed by the platform, never user content.
const ERRNO_TOKEN = /^E[A-Z0-9_]{1,40}$/;

type TypedCause = Pick<ElwoodError, "code" | "details">;

/**
 * `Cleanup failed.`, or `Cleanup failed (termination_failed EPERM).` when the failure is
 * typed. A `teardown_failed` from `teardown()` is summarized by the typed failures of its
 * steps (`details.failures`, §10); an untyped one adds nothing.
 */
export function cleanupFailureMessage(error: unknown): string {
  const parts = typedCauses(error).map(({ code, details }) => {
    const errno = details["errno"];
    return typeof errno === "string" && ERRNO_TOKEN.test(errno) ? `${code} ${errno}` : code;
  });
  return parts.length === 0 ? "Cleanup failed." : `Cleanup failed (${parts.join(", ")}).`;
}

function typedCauses(error: unknown): readonly TypedCause[] {
  if (!(error instanceof ElwoodError)) return [];
  const failures = error.details["failures"];
  if (!Array.isArray(failures)) return [error];
  // `runTeardownSteps` builds this list; an untyped step failure has only a message.
  return (failures as readonly TeardownFailure[]).filter((failure) => "code" in failure);
}
