/**
 * Process-wide async mutex for the macOS clipboard. The clipboard is a single
 * global resource, but Elwood sessions serialize only per-session, so two
 * concurrent Codex image attaches could interleave their snapshot/set/paste/
 * restore transactions and cross-attach each other's images. This serializes the
 * whole transaction across all sessions in the process. Implements PRD §5.3
 * (C-API-46).
 */

let tail: Promise<void> = Promise.resolve();

/**
 * Runs `task` while holding the clipboard lock: each caller waits for the prior
 * holder to finish before starting, and the lock is released when `task`
 * settles (success or failure), so a failing attach never wedges the queue.
 */
export function withClipboardLock<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task, task);
  // Keep the chain alive but swallow errors on the internal tail so one caller's
  // rejection does not reject the NEXT caller's acquire; the real result/rejection
  // is returned to THIS caller via `run`.
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
