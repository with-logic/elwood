/**
 * The Codex setModel config transaction: snapshot → drive the picker → restore,
 * all under the process-wide config lock. Factored out of session-instance so
 * every branch (switch succeeds/rejects × restore succeeds/throws) is unit
 * testable without a live session. Implements PRD §5.3 setModel restore and
 * C-CODEX-14 (a late picker rejection must still restore, and a restore failure
 * must never mask the primary automation error).
 */

import type { MutexCancel } from "../../core/async-mutex.ts";
import { withCodexConfigLock } from "./lock.ts";

type CodexModelSwitch = {
  /** Reads the current config.toml so it can be restored after the switch. */
  readonly snapshot: () => string | undefined;
  /** Drives the picker; rejects if the CLI automation fails or times out. */
  readonly apply: () => Promise<void>;
  /** Compare-and-swap restore of the snapshot; may warn but should not throw. */
  readonly restore: (snapshot: string | undefined) => void;
  /**
   * Reports a restore failure that had to be SWALLOWED because a primary error is
   * being preserved (both the picker and the restore failed). Without this the user
   * would get no signal that their global config.toml may remain mutated. Optional;
   * omitted in tests that don't assert the diagnostic.
   */
  readonly onRestoreError?: (error: unknown) => void;
  /**
   * Consulted on BOTH outcomes, because the question is whether the CLI can still write
   * config.toml, not whether our automation succeeded. A returned promise means the CLI
   * may still be alive and able to persist its selection (the session is closing): a
   * rejecting caller gets its error at once, while the restore, and with it the config
   * lock, waits for that promise. Returning nothing restores immediately, which is the
   * ordinary non-closing path.
   *
   * The wait is BEST-EFFORT and bounded: it settles on the observed PTY exit, or on its
   * own deadline if the process never reports one. So the restore is ordered after a
   * confirmed exit in the normal case, but a CLI that never exits cannot hold the
   * process-wide config lock indefinitely — it is a bound, not a guarantee of exit.
   */
  readonly waitForCliExit?: () => Promise<unknown> | undefined;
  /**
   * Cancels this switch while it is still WAITING for the process-wide config lock, so a
   * deadline or session close behind another transaction rejects at once instead of
   * waiting out that transaction (including its exit bound). Once this switch holds the
   * lock it owns config.toml and must finish its snapshot/restore.
   */
  readonly cancel?: MutexCancel;
};

export function runCodexModelSwitch(io: CodexModelSwitch): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const transaction = withCodexConfigLock(async () => {
      const snapshot = io.snapshot();
      let primary: unknown;
      let failed = false;
      try {
        await io.apply();
      } catch (error) {
        failed = true;
        primary = error;
      }
      // The barrier is about the CLI still being able to WRITE, which has nothing to do
      // with whether our picker automation succeeded. A switch that applied cleanly and
      // then raced termination must defer its restore just as a failed one does, or the
      // dying process's final config write lands after it. `waitForCliExit` returns
      // undefined unless the session is closing, so the ordinary path is unchanged.
      const exitWait = io.waitForCliExit?.();
      // A non-undefined wait means the session is CLOSING. The caller is told immediately
      // and identically either way: a switch that "succeeded" into a terminating session
      // did not take effect for that session, so reporting success — five seconds later,
      // once the exit barrier cleared — would be a lie. Only the restore waits.
      const closing = exitWait !== undefined;
      if (closing) {
        // `failed` is always true here in practice: the queue slot's close signal aborts
        // every picker read and write, so a switch cannot APPLY into a closing session.
        // The rejection is still delivered before the wait so the caller is never held for
        // the exit bound, and the restore below is told the call has already settled.
        reject(primary);
        await exitWait;
      }
      // `settled` tells the restore its failure can no longer reach the caller through the
      // returned promise, so it must be REPORTED instead of thrown into a void.
      restoreAfterSwitch(io, snapshot, failed || closing);
      if (failed) throw primary;
    }, io.cancel);
    // A rejection already delivered above makes this one a no-op.
    transaction.then(resolve, reject);
  });
}

/**
 * Restores whether or not the switch rejected, so a late picker timeout that fired
 * AFTER Codex wrote config.toml still restores the user's default. When the switch
 * succeeded AND the caller is still listening, a restore failure surfaces on its own. Once
 * the call has already settled — a preserved primary error, or a termination rejection
 * delivered before the barrier — the restore failure cannot be thrown, but it must NOT
 * vanish (that would leave config.toml holding the temporary model silently): it is
 * reported so the user learns config.toml may still be mutated. The report is
 * CONTAINED: a throwing reporter must never replace the primary error.
 */
function restoreAfterSwitch(
  io: CodexModelSwitch,
  snapshot: string | undefined,
  settled: boolean,
): void {
  try {
    io.restore(snapshot);
  } catch (restoreError) {
    if (!settled) throw restoreError;
    try {
      io.onRestoreError?.(restoreError);
    } catch {
      // A throwing reporter must not replace the primary error the caller preserves.
    }
  }
}
