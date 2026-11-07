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
import { assertLeaderObservation } from "./detached-sweep/held-leader.ts";
import type { SurvivorWatch } from "./detached-sweep/survivor-watch.ts";
import { mergeSweepErrors } from "./merge-sweep-errors.ts";
import type { SessionReaper } from "./reap-tree.ts";

type TerminationTimeouts = { readonly gracefulMs: number; readonly forceMs: number };
type TerminationReaper = Pick<
  SessionReaper,
  "reap" | "sweepDetached" | "signalLeaderPty" | "watchSurvivors"
>;
const defaultTimeouts: TerminationTimeouts = { gracefulMs: 5_000, forceMs: 1_000 };
const POST_EXIT_REAP_RETRIES = 4;
const POST_EXIT_REAP_RETRY_MS = 25;

/**
 * Graceful stop records observed descendants before TERM and holds/verifies the original
 * leader before signaling it. The same latch cancels escalation after native exit.
 * Grace expiry reaps the retained original groups with fresh verification. Finish joins
 * that cleanup on every path; it never falls back to a saved numeric group. Uncertain identity,
 * gone-group evidence and an earlier failed verification prohibit later leader signals.
 * Independent observed survivor groups remain eligible for verified cleanup (C-LIFE-10).
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
  let watch: SurvivorWatch | undefined;
  try {
    const latch = new PtyExitLatch(pty);
    exit = latch;
    if (signal === "SIGTERM") {
      watch = reaper.watchSurvivors(() => latch.exited);
      const observation = await watch.firstObservation;
      assertLeaderObservation(observation);
      const outcome = latch.exited ? undefined : await watch.sendSignal(() => pty.kill("SIGTERM"));
      const groupGone = outcome === "leader-group-gone";
      observedExit = latch.exited || groupGone || (await latch.within(timeouts.gracefulMs));
    }
    if (!observedExit) {
      sweepError = await (watch?.reap() ?? reaper.sweepDetached(() => latch.exited)).then(
        () => undefined,
        toError,
      );
      const leaderGroupGone =
        watch === undefined &&
        !latch.exited &&
        reaper.signalLeaderPty(() => pty.kill("SIGKILL")) === "leader-group-gone";
      observedExit = leaderGroupGone || (await latch.within(timeouts.forceMs));
      if (!observedExit) {
        terminationError = elwoodError("termination_failed", "PTY did not exit after SIGKILL.");
      }
    }
  } catch (error) {
    terminationError = terminationOperationFailed(error);
  } finally {
    try {
      await watch?.finish(terminationError !== undefined);
    } catch (error) {
      sweepError = mergeSweepErrors(sweepError, error);
    }
    exit?.dispose();
  }
  if (sweepError !== undefined) {
    terminationError =
      terminationError === undefined
        ? sweepOnlyFailed(sweepError)
        : withCause(terminationError, "sweepError", sweepError);
  }
  // Attempt the final reap through SessionReaper's retained signal authority.
  // Refusal or a failed reap remains typed; when termination also failed, preserve both.
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
 * Routes retained sweep failures to their wrapper. Other termination failures, including
 * PTY operations, observations and ownership verification, become `termination_failed`
 * with message/errno/syscall/path details. Thus `stop()`/`kill()` never reject with a raw
 * system error whose own
 * `code` (e.g. `ESRCH`) masquerades as an Elwood error name (PRD §10, C-ERR-01).
 */
function terminationOperationFailed(error: unknown): ElwoodError {
  if ("processGroupIds" in toError(error)) return sweepOnlyFailed(error);
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
function reapOnlyFailed(reapError: unknown): ElwoodError {
  return elwoodError(
    "termination_failed",
    "PTY exited but its process group could not be reaped.",
    {
      ...causeDetails(reapError),
    },
  );
}

/** The same typed wrapping when only the process-tree sweep failed. */
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
  const { processGroupIds } = error as Partial<SweepFailure>;
  return processGroupIds !== undefined && processGroupIds.length > 0
    ? { unconfirmedProcessGroupIds: [...processGroupIds] }
    : {};
}
