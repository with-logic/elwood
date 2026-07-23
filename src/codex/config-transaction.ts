/**
 * The Codex setModel config transaction: snapshot → drive the picker → restore,
 * all under the process-wide config lock. Factored out of session-instance so
 * every branch (switch succeeds/rejects × restore succeeds/throws) is unit
 * testable without a live session. Implements PRD §5.3 setModel restore and
 * C-CODEX-14 (a late picker rejection must still restore, and a restore failure
 * must never mask the primary automation error).
 */

import { withCodexConfigLock } from "./config-lock.ts";

export type CodexModelSwitch = {
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
};

export function runCodexModelSwitch(io: CodexModelSwitch): Promise<void> {
  return withCodexConfigLock(async () => {
    const snapshot = io.snapshot();
    let primary: unknown;
    let failed = false;
    try {
      await io.apply();
    } catch (error) {
      failed = true;
      primary = error;
    }
    // Restore whether or not the switch rejected, so a late picker timeout that
    // fired AFTER Codex wrote config.toml still restores the user's default.
    try {
      io.restore(snapshot);
    } catch (restoreError) {
      // When the switch succeeded, a restore failure surfaces on its own. When a
      // primary error is being preserved we cannot also throw the restore failure,
      // but it must NOT vanish — report it so the user learns config.toml may still
      // be mutated (the alternative, silently dropping it, was the bug). The report
      // is CONTAINED here: a throwing reporter must never replace the primary error
      // this function guarantees to preserve.
      if (!failed) throw restoreError;
      try {
        io.onRestoreError?.(restoreError);
      } catch {}
    }
    if (failed) throw primary;
  });
}
