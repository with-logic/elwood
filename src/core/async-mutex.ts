/**
 * A minimal process-local async mutex: a promise chain that serializes tasks so
 * each caller waits for the prior holder to settle before starting. The internal
 * tail swallows rejections so one caller's failure never rejects the NEXT caller's
 * acquire; the real result/rejection is returned to THIS caller. Shared by the
 * clipboard and Codex config locks (PRD §5.3, C-API-46 / C-CODEX-14); extracted
 * so the one correct chaining shape lives in one place.
 */

/**
 * Cancels a caller that is still WAITING for the mutex. Once its task has started the
 * task owns the critical section and must finish, so cancellation only removes a waiter.
 */
export type MutexCancel = {
  readonly signal: AbortSignal;
  /** The error the cancelled waiter rejects with. */
  readonly error: () => unknown;
};

/** Runs `task` while holding the mutex; released when `task` settles (ok or error). */
export type AsyncMutex = <T>(task: () => Promise<T>, cancel?: MutexCancel) => Promise<T>;

/** Creates an independent async mutex with its own serialization chain. */
export function createAsyncMutex(): AsyncMutex {
  let tail: Promise<void> = Promise.resolve();
  return <T>(task: () => Promise<T>, cancel?: MutexCancel): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let stopWaiting: () => void = () => undefined;
      if (cancel) {
        // Reject waiting callers immediately. Their queued run stays in the tail,
        // preserving ordering. Already-aborted signals never replay an abort event.
        if (cancel.signal.aborted) return reject(cancel.error());
        const abort = () => reject(cancel.error());
        cancel.signal.addEventListener("abort", abort, { once: true });
        stopWaiting = () => cancel.signal.removeEventListener("abort", abort);
      }
      const run = tail.then(() => {
        // Acquisition ends waiter cancellation. An active task must retain ownership
        // until its own abort handling and cleanup settle, even if its signal aborts.
        stopWaiting();
        if (cancel?.signal.aborted) throw cancel.error();
        return task();
      });
      tail = run.then(
        (value) => resolve(value),
        (error: unknown) => reject(error),
      );
    });
}
