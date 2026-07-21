/**
 * Process-wide async mutex for the Codex `config.toml`. The file is a single
 * process-global resource, but Elwood sessions serialize only per-session, so
 * two concurrent `setModel` switches could interleave their snapshot / picker /
 * compare-and-swap restore transactions on the shared file and leave the wrong
 * model persisted as the user's default. This serializes the whole transaction
 * across all sessions in the process. Mirrors clipboard-lock.ts and implements
 * PRD §5.3 setModel restore and C-CODEX-14.
 */

let tail: Promise<void> = Promise.resolve();

/**
 * Runs `task` while holding the config lock: each caller waits for the prior
 * holder to finish before starting, and the lock is released when `task`
 * settles (success or failure), so a failing switch never wedges the queue.
 */
export function withCodexConfigLock<T>(task: () => Promise<T>): Promise<T> {
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
