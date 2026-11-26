/**
 * Non-throwing recovery for a failed transcript poll (PRD §5.4 and §5.7 `transcript_poll_stopped`,
 * C-CODEX-20). `finish()` and the poll-error diagnostic can each throw a listener error, which would
 * become a host-terminating unhandled rejection, so each step is contained.
 */
export function recoverFromPollError(
  watcher: { finish(): void; stop(): void },
  onPollError: ((error: unknown) => void) | undefined,
  error: unknown,
): void {
  try {
    watcher.finish();
  } catch {
    watcher.stop(); // finish() threw mid-drain: still guarantee the timer is cleared
  }
  try {
    onPollError?.(error);
  } catch {} // a diagnostic listener bug must not resurrect the failure
}
