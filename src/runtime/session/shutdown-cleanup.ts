/**
 * Runtime cleanup for an explicit `stop()`/`kill()` attempt (PRD §9.4 and §10,
 * C-LIFE-10): cleanup runs after every attempt to terminate the PTY or, once it was
 * signaled, to reap it, failed or not. So a PTY that could not be signaled, did not
 * exit, or could not be reaped never leaves the session's runtime (its hook bridge and
 * terminal renderer, and Codex's transcript watcher) running until a later `teardown()`.
 */

import { causeDetails, ElwoodError, elwoodError, toError } from "../../core/errors.ts";

/**
 * Runs `attempt` (a PTY termination, or the survivor reap of an already-signaled one),
 * then `cleanupRuntime` whether or not `attempt` rejected, and rejects with a typed
 * `termination_failed` (C-ERR-01). The attempt's failure stays the rejection, carrying a
 * cleanup failure's message alongside it in `details.cleanupError`. A cleanup
 * failure alone is wrapped too: `runCleanupSteps` rejects with a bare `Error` on the
 * assumption that its caller wraps it, and `stop()`/`kill()` are that caller.
 */
export async function shutdownAttemptThenCleanUp(
  attempt: () => Promise<void> | void,
  cleanupRuntime: () => Promise<void>,
): Promise<void> {
  let terminationError: ElwoodError | undefined;
  try {
    await attempt();
  } catch (error) {
    terminationError = asTerminationFailure(error);
  }
  try {
    await cleanupRuntime();
  } catch (error) {
    const cleanupError = toError(error).message;
    if (terminationError === undefined) {
      throw elwoodError("termination_failed", "Could not clean up the Elwood runtime.", {
        cause: cleanupError,
      });
    }
    throw elwoodError(terminationError.code, terminationError.message, {
      ...terminationError.details,
      cleanupError,
    });
  }
  if (terminationError !== undefined) throw terminationError;
}

/** The typed failure `stop()`/`kill()` reject with, even for an untyped throw. */
function asTerminationFailure(error: unknown): ElwoodError {
  if (error instanceof ElwoodError) return error;
  return elwoodError("termination_failed", toError(error).message, causeDetails(error));
}
