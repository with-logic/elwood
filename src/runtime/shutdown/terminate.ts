/**
 * Shared PTY termination helper for graceful stop and force kill.
 * Implements PRD §5.3 and §9.4.
 */

import { type ElwoodError, elwoodError, errnoCode, toError } from "../../core/errors.ts";
import { PtyExitLatch } from "../../pty/exit-latch.ts";
import type { PtyProcess } from "../../pty/types.ts";
import type { SessionReaper } from "./reap-tree.ts";
import { ptyOperationFailed, sweepOnlyFailed, terminationFailure } from "./termination-errors.ts";

type TerminationTimeouts = { readonly gracefulMs: number; readonly forceMs: number };
type TerminationReaper = Pick<SessionReaper, "reap" | "sweepDetached" | "signalLeaderPty">;
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
 * still the parent of its `setsid()` hooks. A leader that exits on SIGTERM is not
 * swept: the CLI's own graceful shutdown ends its hooks. One exit latch spans every
 * phase, and once it has seen the exit, nothing more is sent to the leader's pid,
 * which may already belong to another process: an exit during the sweep's table reads
 * cancels the SIGKILL. A sweep failure is reported like a reap failure, after the
 * leader is still killed and reaped unless its whole group was confirmed gone. That
 * terminal fact cancels all later PTY and group signals without clearing old failures.
 * Group disappearance does not replace the native PTY exit notification: its existing
 * bounded wait still applies, and a missing notification fails termination.
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
  try {
    const latch = new PtyExitLatch(pty);
    exit = latch;
    if (signal === "SIGTERM") {
      reaper.signalLeaderPty(() => pty.kill("SIGTERM"));
      observedExit = await latch.within(timeouts.gracefulMs);
    }
    if (!observedExit) {
      sweepError = await reaper.sweepDetached(() => latch.exited).then(() => undefined, toError);
      if (!latch.exited) reaper.signalLeaderPty(() => pty.kill("SIGKILL"));
      observedExit = await latch.within(timeouts.forceMs);
      if (!observedExit) {
        terminationError = elwoodError(
          "termination_failed",
          "PTY exit was not observed within the termination window.",
        );
      }
    }
  } catch (error) {
    terminationError =
      "processGroupIds" in toError(error) ? sweepOnlyFailed(error) : ptyOperationFailed(error);
  } finally {
    exit?.dispose();
  }
  // Reap on every path — even if the wait timed out or a PTY call threw — so a
  // termination_failed outcome never leaks the descendant tree (C-LIFE-10). The
  // reaper does NOT latch on failure, so a later teardown can retry. No cause is dropped
  // and no raw system error escapes (PRD §10, C-ERR-01).
  const reapFailure = await reapAfterTermination(reaper, observedExit).then(
    () => undefined,
    (error: unknown) => ({ error }),
  );
  const failure = terminationFailure(terminationError, sweepError, reapFailure);
  if (failure !== undefined) throw failure;
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
