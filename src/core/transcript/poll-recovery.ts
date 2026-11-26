/**
 * Non-throwing recovery for a failed transcript poll, shared by the Claude and Codex watchers
 * (PRD §5.4 and §5.7 `transcript_poll_stopped`, C-CODEX-20). `finish()` and the poll-error
 * diagnostic can each throw a listener error, which would terminate the host from a timer, so
 * each step is contained.
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
