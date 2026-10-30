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
import { PtyExitLatch } from "../../pty/exit-latch.ts";
import type { PtyProcess } from "../../pty/types.ts";
import type { SweepFailure } from "./detached-sweep/failures.ts";
import type { SurvivorWatch } from "./detached-sweep/survivors.ts";
import type { SessionReaper } from "./reap-tree.ts";

type TerminationTimeouts = { readonly gracefulMs: number; readonly forceMs: number };
type TerminationReaper = Pick<SessionReaper, "reap" | "sweepDetached" | "watchSurvivors">;
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
 *
 * Before the SIGKILL — the initial signal, or the escalation after an ignored
 * SIGTERM — the detached-descendant sweep runs while the leader is still alive and
 * still the parent of its `setsid()` hooks. A SIGTERM is sent only after one table
 * read, and reads repeat until the leader exits, recording its detached descendants;
 * once it has exited, those still alive are reaped (`survivors.ts`), since a CLI's
 * graceful exit can leave them running. One exit latch spans every phase, and once it
 * has seen the exit, nothing more is sent to the leader's pid, which may already belong
 * to another process: an exit during the sweep's table reads cancels the SIGKILL. A
 * sweep or survivor failure is reported like a reap failure, after the leader's group
 * is still reaped; a leader whose exit was seen is not signaled again.
 */
export async function terminatePty(
  pty: PtyProcess,
  signal: "SIGTERM" | "SIGKILL",
  reaper: TerminationReaper,
  timeouts: TerminationTimeouts = defaultTimeouts,
): Promise<void> {
  let terminationError: ElwoodError | undefined;
  let sweepError: unknown;
  let observedExit = false;
  let exit: PtyExitLatch | undefined;
  let survivors: SurvivorWatch | undefined;
  try {
    const latch = new PtyExitLatch(pty);
    exit = latch;
    if (signal === "SIGTERM") {
      let leaderGone = false;
      survivors = reaper.watchSurvivors(() => latch.exited || leaderGone);
      leaderGone = await survivors.firstRead;
      if (!(latch.exited || leaderGone)) pty.kill("SIGTERM");
      observedExit = leaderGone || (await latch.within(timeouts.gracefulMs));
    }
    if (!observedExit) {
      sweepError = await reaper.sweepDetached(() => latch.exited).then(() => undefined, toError);
      if (!latch.exited) pty.kill("SIGKILL");
      observedExit = await latch.within(timeouts.forceMs);
      if (!observedExit) {
        terminationError = elwoodError("termination_failed", "PTY did not exit after SIGKILL.");
      }
    }
  } catch (error) {
    terminationError = ptyOperationFailed(error);
  } finally {
    exit?.dispose();
  }
  // Always ends the watch, which reads until told; an earlier sweep failure is the one reported.
  const survivorError = await survivors
    ?.finish(terminationError !== undefined)
    .then(() => undefined, toError);
  sweepError ??= survivorError;
  if (sweepError !== undefined) {
    terminationError =
      terminationError === undefined
        ? sweepOnlyFailed(sweepError)
        : withCause(terminationError, "sweepError", sweepError);
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
    throw withCause(terminationError, "reapError", reapError);
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
 * Builds one error preserving BOTH the termination failure and a secondary cause:
 * the reap failure (`reapError`, with its errno in `reapErrno`) or the
 * detached-descendant sweep failure (`sweepError`). The secondary cause is carried in
 * `details` under its own keys (NOT `details.cause`/`errno`, which the termination
 * error may already use for its own root cause), so neither cause is dropped
 * (C-LIFE-10).
 */
function withCause(
  terminationError: ElwoodError,
  key: "reapError" | "sweepError",
  secondary: unknown,
): ElwoodError {
  const reapErrno = key === "reapError" ? errnoCode(secondary) : undefined;
  return elwoodError(terminationError.code, terminationError.message, {
    ...terminationError.details,
    [key]: toError(secondary).message,
    ...(reapErrno === undefined ? {} : { reapErrno }),
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

/** The same typed wrapping when only the detached-descendant sweep failed. */
function sweepOnlyFailed(sweepError: unknown): ElwoodError {
  return elwoodError(
    "termination_failed",
    "PTY exited but its detached descendants could not be confirmed reaped.",
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
