/** Preserve setup causes and owned-state rollback failures (PRD §8.1, C-STATE-14). */
import { causeDetails, ElwoodError, elwoodError, toError } from "../core/errors.ts";

export function stateCleanupFailure(error: unknown, cleanupErrorCode: string | undefined): unknown {
  if (cleanupErrorCode === undefined) return error;
  return error instanceof ElwoodError
    ? elwoodError(error.code, error.message, { cleanupErrorCode, ...error.details })
    : Object.assign(toError(error), {
        cleanupErrorCode: causeDetails(error)["cleanupErrorCode"] ?? cleanupErrorCode,
      });
}
