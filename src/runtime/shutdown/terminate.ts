/**
 * Shared PTY termination helper for graceful stop and force kill.
 * Implements PRD §5.3 and §9.4.
 */

import {
  causeDetails,
  type ElwoodError,
  elwoodError,
  errnoCode,
  toError,
} from "../../core/errors.ts";
import type { PtyProcess } from "../../pty/types.ts";
import type { SessionReaper } from "./reap-tree.ts";

type TerminationTimeouts = { readonly gracefulMs: number; readonly forceMs: number };
const defaultTimeouts: TerminationTimeouts = { gracefulMs: 5_000, forceMs: 1_000 };
const POST_EXIT_REAP_RETRIES = 4;
const POST_EXIT_REAP_RETRY_MS = 25;

/**
 * Signal the PTY, wait for exit, and reap the leader's process group. The reap is
 * ATTEMPTED on EVERY exit path — normal exit, timeout, or a throwing PTY operation
 * — so no path skips it. It does NOT guarantee the tree is gone: a failing reap
 * (e.g. EPERM) still leaves descendants alive, so that failure is PROPAGATED as a
 * typed `termination_failed` (never swallowed) and the reaper stays unlatched so a
 * later `teardown()` RETRIES it. A successful reap latches, so a later reuse is a
 * harmless no-op (see SessionReaper) (C-LIFE-10).
 */
export async function terminatePty(
  pty: PtyProcess,
  signal: "SIGTERM" | "SIGKILL",
  reaper: Pick<SessionReaper, "reap">,
  timeouts: TerminationTimeouts = defaultTimeouts,
): Promise<void> {
  let terminationError: ElwoodError | undefined;
  let observedExit = false;
  try {
    const timeoutMs = signal === "SIGTERM" ? timeouts.gracefulMs : timeouts.forceMs;
    const exited = await waitForExitAfterSignal(pty, signal, timeoutMs);
    // On a SIGTERM timeout, escalate to SIGKILL. The reported signal is the one
    // whose wait actually failed, so an operator is sent to the right phase.
    const escalated =
      !exited && signal === "SIGTERM"
        ? await waitForExitAfterSignal(pty, "SIGKILL", timeouts.forceMs)
        : exited;
    observedExit = escalated;
    if (!escalated) {
      const failedSignal = signal === "SIGTERM" ? "SIGKILL" : signal;
      terminationError = elwoodError(
        "termination_failed",
        `PTY did not exit after ${failedSignal}.`,
      );
    }
  } catch (error) {
    terminationError = ptyOperationFailed(error);
  }
  // Reap on every path — even if the wait timed out or a PTY call threw — so a
  // termination_failed outcome never leaks the descendant tree (C-LIFE-10). The
  // reaper does NOT latch on failure, so a later teardown can retry. When BOTH
  // termination and reap fail, neither cause is dropped: the thrown error keeps
  // the termination message and carries the reap failure in its details. When
  // ONLY the reap fails (termination succeeded), the raw system error is wrapped
  // as a typed `termination_failed` so the caller always rejects with an
  // ElwoodError, never a bare EPERM (PRD §10, C-ERR-01).
  try {
    await reapAfterTermination(reaper, observedExit);
  } catch (reapError) {
    if (terminationError === undefined) throw reapOnlyFailed(reapError);
    throw bothFailed(terminationError, reapError);
  }
  if (terminationError !== undefined) throw terminationError;
}

async function reapAfterTermination(
  reaper: Pick<SessionReaper, "reap">,
  observedExit: boolean,
): Promise<void> {
  let retries = observedExit ? POST_EXIT_REAP_RETRIES : 0;
  while (true) {
    try {
      reaper.reap();
      return;
    } catch (error) {
      if (errnoCode(error) !== "EPERM" || retries === 0) throw error;
      retries -= 1;
      await new Promise((resolve) => setTimeout(resolve, POST_EXIT_REAP_RETRY_MS));
    }
  }
}

/**
 * Builds one error preserving BOTH the termination and the reap failure causes.
 * The reap cause is carried in `details.reapError` (NOT `details.cause`, which the
 * termination error may already use for its own root cause), so neither cause is
 * dropped (C-LIFE-10). Callers/tests read `details.reapError`.
 */
function bothFailed(terminationError: ElwoodError, reapError: unknown): ElwoodError {
  return elwoodError(terminationError.code, terminationError.message, {
    ...terminationError.details,
    reapError: toError(reapError).message,
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

function waitForExitAfterSignal(
  pty: PtyProcess,
  signal: "SIGTERM" | "SIGKILL",
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(() => {
      unsubscribe?.();
      resolve(false);
    }, timeoutMs);
    try {
      unsubscribe = pty.onExit(() => {
        clearTimeout(timer);
        unsubscribe?.();
        resolve(true);
      });
      pty.kill(signal);
    } catch (error) {
      clearTimeout(timer);
      unsubscribe?.();
      reject(error);
    }
  });
}
