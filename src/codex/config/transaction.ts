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
   * session that closes behind another session's transaction rejects at once instead of
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
      if (exitWait !== undefined) {
        // The caller learns the outcome at once; only the restore waits.
        if (failed) reject(primary);
        await exitWait;
      }
      restoreAfterSwitch(io, snapshot, failed);
      if (failed) throw primary;
    }, io.cancel);
    // A rejection already delivered above makes this one a no-op.
    transaction.then(resolve, reject);
  });
}

/**
 * Restores whether or not the switch rejected, so a late picker timeout that fired
 * AFTER Codex wrote config.toml still restores the user's default. When the switch
 * succeeded, a restore failure surfaces on its own. When a primary error is being
 * preserved the restore failure cannot also be thrown, but it must NOT vanish: it is
 * reported so the user learns config.toml may still be mutated. The report is
 * CONTAINED: a throwing reporter must never replace the primary error.
 */
function restoreAfterSwitch(
  io: CodexModelSwitch,
  snapshot: string | undefined,
  failed: boolean,
): void {
  try {
    io.restore(snapshot);
  } catch (restoreError) {
    if (!failed) throw restoreError;
    try {
      io.onRestoreError?.(restoreError);
    } catch {
      // A throwing reporter must not replace the primary error the caller preserves.
    }
  }
}
