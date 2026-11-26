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
import { isSweepFailure } from "./detached-sweep/failures.ts";

type SecondaryErrorKey = "reapError" | "sweepError";
const secondaryErrnoKey: Readonly<Record<SecondaryErrorKey, string>> = {
  reapError: "reapErrno",
  sweepError: "sweepErrno",
};

/** Preserve primary diagnostics and label secondary cleanup details by phase (C-LIFE-10). */
function withCause(
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
function ptyOperationFailed(error: unknown): ElwoodError {
  return elwoodError(
    "termination_failed",
    `Could not terminate the PTY: ${toError(error).message}`,
    causeDetails(error),
  );
}

/**
 * Wraps a reap-only failure (PTY termination SUCCEEDED, the group reap FAILED) as
 * a typed `termination_failed` error with a normalized cause (errno/syscall/path
 * when available), so `stop()`/`kill()` reject with an ElwoodError rather than a
 * raw system error (PRD §10, C-ERR-01, C-LIFE-10).
 */
function reapOnlyFailed(reapError: unknown): ElwoodError {
  return elwoodError(
    "termination_failed",
    "PTY exited but its process group could not be reaped.",
    {
      ...causeDetails(reapError),
    },
  );
}

/**
 * Wraps a sweep failure (the process-tree sweep could not confirm every group reaped) as a
 * typed `termination_failed`, carrying its cause and `unconfirmedProcessGroupIds` (PRD §10,
 * C-ERR-01, C-LIFE-10).
 */
function sweepOnlyFailed(sweepError: unknown): ElwoodError {
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
  return isSweepFailure(error) && error.processGroupIds.length > 0
    ? { unconfirmedProcessGroupIds: [...error.processGroupIds] }
    : {};
}

/**
 * The typed `termination_failed` for a PTY step that threw: a sweep failure, which
 * `signalLeaderPty` rethrows when an earlier sweep left groups unconfirmed, keeps its groups;
 * anything else is a PTY operation failure.
 */
export function thrownTerminationFailure(error: unknown): ElwoodError {
  return isSweepFailure(toError(error)) ? sweepOnlyFailed(error) : ptyOperationFailed(error);
}

/**
 * The one error a termination reports, if any. Precedence is termination, then sweep, then
 * reap: the first failure present supplies the message and later ones ride in its details
 * (`sweepError`, `reapError`), so a sweep and a reap failure without a termination failure
 * report the sweep message with `reapError` attached. A sweep or reap failure alone is a
 * typed `termination_failed`, never a bare system error (C-ERR-01). The reap rejection is
 * boxed so its raw value is kept as caught, its errno included, and a rejection with
 * `undefined` still counts as a failure.
 */
export function terminationFailure(
  terminationError: ElwoodError | undefined,
  sweepError: Error | undefined,
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
