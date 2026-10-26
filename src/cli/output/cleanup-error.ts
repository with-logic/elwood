/**
 * The CLI's diagnostic for a failed session cleanup (PRD §12A.2, C-CLI-09): it names the
 * typed Elwood failures behind it, each always by its error code, then by its errno tokens
 * and unconfirmed process-group ids when it has them. It never carries their messages,
 * paths, or other free text.
 * Text mode's error lines (§12A.3) carry it beside a different primary failure.
 */

import { ElwoodError, isErrnoToken } from "../../core/errors.ts";
import { MAX_REPORTED_GROUPS } from "../../runtime/shutdown/detached-sweep/failures.ts";
import type { TeardownFailure } from "../../runtime/shutdown/teardown.ts";
import type { CliError } from "./types.ts";

type TypedCause = Pick<ElwoodError, "code" | "details">;

/**
 * `Cleanup failed.`, or `Cleanup failed (termination_failed EPERM).` when the failure is
 * typed. A `teardown_failed` from `teardown()` is summarized by the typed failures of its
 * steps (`details.failures`, §10), in order; an untyped one adds nothing.
 */
export function cleanupFailureMessage(error: unknown): string {
  const parts = typedCauses(error).map(describeCause);
  return parts.length === 0 ? "Cleanup failed." : `Cleanup failed (${parts.join(", ")}).`;
}

/**
 * Text mode's stderr lines for an error record (§12A.3), each `prefix` then a sanitized
 * value: the error, then the cleanup diagnostic when a failed cleanup sits behind a
 * different primary failure (§12A.2). A cleanup failure that is itself the primary
 * failure is the error's own line.
 */
export function textErrorLines(
  record: CliError,
  prefix: string,
  value: (text: string) => string,
): string {
  const { cleanup, error } = record;
  const separate = cleanup.status === "failed" && error.code !== "cleanup_failed";
  const lines = separate ? [error.message, cleanup.error] : [error.message];
  return lines.map((line) => `${prefix}${value(line)}\n`).join("");
}

function typedCauses(error: unknown): readonly TypedCause[] {
  if (!(error instanceof ElwoodError)) return [];
  const failures = error.details["failures"];
  if (!Array.isArray(failures)) return [error];
  // `runTeardownSteps` builds this list; an untyped step failure has only a message.
  return (failures as readonly TeardownFailure[]).filter((failure) => "code" in failure);
}

/**
 * `termination_failed EIO reap EPERM process groups 4242 4243`: the code, its errno, its
 * reap's, then the process groups a detached sweep could not confirm reaped (§10).
 */
function describeCause({ code, details }: TypedCause): string {
  const errno = errnoToken(details["errno"]);
  const reapErrno = errnoToken(details["reapErrno"]);
  const groups = processGroupIds(details["unconfirmedProcessGroupIds"]);
  return [
    code,
    errno,
    reapErrno === undefined ? undefined : `reap ${reapErrno}`,
    groups.length === 0 ? undefined : `process groups ${groups.join(" ")}`,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
}

function errnoToken(value: unknown): string | undefined {
  return isErrnoToken(value) ? value : undefined;
}

/** Positive integer ids only, as many as a sweep failure can name. */
function processGroupIds(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is number => Number.isSafeInteger(id) && id > 0);
  return ids.slice(0, MAX_REPORTED_GROUPS);
}
