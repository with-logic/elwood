/**
 * A minimal process-local async mutex: a promise chain that serializes tasks so
 * each caller waits for the prior holder to settle before starting. The internal
 * tail swallows rejections so one caller's failure never rejects the NEXT caller's
 * acquire; the real result/rejection is returned to THIS caller. Shared by the
 * clipboard and Codex config locks (PRD §5.3, C-API-46 / C-CODEX-14); extracted
 * so the one correct chaining shape lives in one place.
 */

/** Runs `task` while holding the mutex; released when `task` settles (ok or error). */
export type AsyncMutex = <T>(task: () => Promise<T>) => Promise<T>;

/** Creates an independent async mutex with its own serialization chain. */
export function createAsyncMutex(): AsyncMutex {
  let tail: Promise<void> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task); // `tail` never rejects, so no rejection arm is needed
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
