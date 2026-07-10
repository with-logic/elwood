/**
 * Shared PTY termination helper for graceful stop and force kill.
 * Implements PRD §5.3 and §9.4.
 */

import { causeDetails, ElwoodError, elwoodError } from "../core/errors.ts";
import type { PtyProcess } from "../pty/types.ts";
import type { SessionReaper } from "./reap-tree.ts";

type TerminationTimeouts = { readonly gracefulMs: number; readonly forceMs: number };
const defaultTimeouts: TerminationTimeouts = { gracefulMs: 5_000, forceMs: 1_000 };

/**
 * Signal the PTY, wait for exit, and reap the leader's process group. The reap
 * is guaranteed on EVERY exit path — normal exit, timeout, or a throwing PTY
 * operation — so a `termination_failed` outcome never leaks the descendants
 * this is meant to kill (C-LIFE-10). The reaper is one-shot and reuse-safe, so
 * a later `teardown()` reaping again is a harmless no-op (see SessionReaper).
 */
export async function terminatePty(
  pty: PtyProcess,
  signal: "SIGTERM" | "SIGKILL",
  reaper: SessionReaper,
  timeouts: TerminationTimeouts = defaultTimeouts,
): Promise<void> {
  let terminationError: unknown;
  try {
    const timeoutMs = signal === "SIGTERM" ? timeouts.gracefulMs : timeouts.forceMs;
    const exited = await waitForExitAfterSignal(pty, signal, timeoutMs);
    // On a SIGTERM timeout, escalate to SIGKILL. The reported signal is the one
    // whose wait actually failed, so an operator is sent to the right phase.
    const escalated =
      !exited && signal === "SIGTERM"
        ? await waitForExitAfterSignal(pty, "SIGKILL", timeouts.forceMs)
        : exited;
    if (!escalated) {
      const failedSignal = signal === "SIGTERM" ? "SIGKILL" : signal;
      terminationError = elwoodError(
        "termination_failed",
        `PTY did not exit after ${failedSignal}.`,
      );
    }
  } catch (error) {
    terminationError = error;
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
    reaper.reap();
  } catch (reapError) {
    if (terminationError === undefined) throw reapOnlyFailed(reapError);
    throw bothFailed(terminationError, reapError);
  }
  if (terminationError !== undefined) throw terminationError;
}

/**
 * Builds one error preserving BOTH the termination and the reap failure causes.
 * An ElwoodError carries the reap cause in `details.reapError`; any other Error
 * carries it on the standard `.cause` — so neither cause is ever dropped, whether
 * termination failed with a typed ElwoodError or a plain PTY Error (C-LIFE-10).
 */
function bothFailed(terminationError: unknown, reapError: unknown): unknown {
  const reap = reapError instanceof Error ? reapError.message : String(reapError);
  if (terminationError instanceof ElwoodError) {
    return elwoodError(terminationError.code, terminationError.message, {
      ...terminationError.details,
      reapError: reap,
    });
  }
  // Any other termination error reaching here is always an Error (ElwoodError is
  // handled above; a thrown PTY value was normalized to Error in
  // waitForExitAfterSignal). Preserve the reap cause on it without losing the
  // original identity/stack.
  (terminationError as Error & { reapError?: string }).reapError = reap;
  return terminationError;
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
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
