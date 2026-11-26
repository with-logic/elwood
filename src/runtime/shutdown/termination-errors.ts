/**
 * Typed `termination_failed` wrapping for PTY termination, group reap and sweep failures
 * (PRD §10, C-ERR-01, C-LIFE-10), keeping primary and secondary diagnostics apart.
 */
import {
  causeDetails,
  type ElwoodError,
  elwoodError,
  errnoCode,
  toError,
} from "../../core/errors.ts";
import type { SweepFailure } from "./detached-sweep/failures.ts";

type SecondaryErrorKey = "reapError" | "sweepError";
const secondaryErrnoKey: Readonly<Record<SecondaryErrorKey, string>> = {
  reapError: "reapErrno",
  sweepError: "sweepErrno",
};

/** Preserve primary diagnostics and label secondary cleanup details by phase (C-LIFE-10). */
export function withCause(
  terminationError: ElwoodError,
  key: SecondaryErrorKey,
  secondary: unknown,
): ElwoodError {
  const errno = errnoCode(secondary);
  return elwoodError(terminationError.code, terminationError.message, {
    ...terminationError.details,
    [key]: toError(secondary).message,
    ...(errno === undefined ? {} : { [secondaryErrnoKey[key]]: errno }),
    ...(key === "sweepError" ? unconfirmedGroupsDetail(toError(secondary)) : {}),
  });
}

/**
 * Wraps a throwing PTY operation (`kill` or `onExit`) as the documented typed
 * `termination_failed`, keeping the underlying message and errno/syscall/path in
 * details, so `stop()`/`kill()` never reject with a raw system error whose own
 * `code` (e.g. `ESRCH`) masquerades as an Elwood error name (PRD §10, C-ERR-01).
 */
export function ptyOperationFailed(error: unknown): ElwoodError {
  return elwoodError(
    "termination_failed",
    `Could not terminate the PTY: ${toError(error).message}`,
    { ...causeDetails(error), ...unconfirmedGroupsDetail(toError(error)) },
  );
}

/**
 * Wraps a reap-only failure (PTY termination SUCCEEDED, the group reap FAILED) as
 * a typed `termination_failed` error with a normalized cause (errno/syscall/path
 * when available), so `stop()`/`kill()` reject with an ElwoodError rather than a
 * raw system error (PRD §10, C-ERR-01, C-LIFE-10).
 */
export function reapOnlyFailed(reapError: unknown): ElwoodError {
  return elwoodError(
    "termination_failed",
    "PTY exited but its process group could not be reaped.",
    {
      ...causeDetails(reapError),
    },
  );
}

/** The same typed wrapping when only the process-tree sweep failed. */
export function sweepOnlyFailed(sweepError: unknown): ElwoodError {
  return elwoodError(
    "termination_failed",
    "PTY exited but its process-tree groups could not be confirmed reaped.",
    { ...causeDetails(sweepError), ...unconfirmedGroupsDetail(toError(sweepError)) },
  );
}

/**
 * `unconfirmedProcessGroupIds`: the process-group ids a sweep failure names, if any: the
 * groups it could not confirm reaped, the leader's own included when its group was not
 * confirmed stopped. Like `processGroupId` they are diagnostic only; an id may already
 * belong to another group.
 */
export function unconfirmedGroupsDetail(error: Error): {
  readonly unconfirmedProcessGroupIds?: number[];
} {
  const { processGroupIds } = error as Partial<SweepFailure>;
  return processGroupIds !== undefined && processGroupIds.length > 0
    ? { unconfirmedProcessGroupIds: [...processGroupIds] }
    : {};
}

/**
 * The one error a termination reports, if any: a termination failure keeps its message
 * and carries sweep and reap failures in its details; a sweep or reap failure alone is
 * wrapped as a typed `termination_failed`, never a bare system error (C-ERR-01).
 */
export function terminationFailure(
  terminationError: ElwoodError | undefined,
  sweepError: unknown,
  reapFailure: { readonly error: unknown } | undefined,
): ElwoodError | undefined {
  let failure = terminationError;
  if (sweepError !== undefined)
    failure =
      failure === undefined
        ? sweepOnlyFailed(sweepError)
        : withCause(failure, "sweepError", sweepError);
  if (reapFailure === undefined) return failure;
  return failure === undefined
    ? reapOnlyFailed(reapFailure.error)
    : withCause(failure, "reapError", reapFailure.error);
}
