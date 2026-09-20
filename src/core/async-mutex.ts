/**
 * Process-local FIFO mutex shared by clipboard and Codex config locks.
 * Cancelled waiters detach immediately; acquired tasks retain ownership through
 * cleanup. Implements PRD §5.3, C-API-46 and C-CODEX-14.
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

/** Creates an independent mutex with removable FIFO waiters. */
export function createAsyncMutex(): AsyncMutex {
  const waiting = new Set<() => void>();
  let running = false;
  const advance = () => {
    const next = waiting.values().next().value;
    if (next === undefined) {
      running = false;
      return;
    }
    waiting.delete(next);
    next();
  };
  return <T>(task: () => Promise<T>, cancel?: MutexCancel): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (cancel?.signal.aborted) return reject(cancel.error());
      let stopWaiting: () => void = () => undefined;
      const run = async () => {
        // Acquisition ends waiter cancellation. The task owns the mutex until its
        // own abort handling and cleanup finish, even when its signal aborts.
        stopWaiting();
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        } finally {
          queueMicrotask(advance);
        }
      };
      if (cancel) {
        const abort = () => {
          // Delete the closure itself so a stalled holder cannot retain this task.
          waiting.delete(run);
          stopWaiting();
          reject(cancel.error());
        };
        cancel.signal.addEventListener("abort", abort, { once: true });
        stopWaiting = () => cancel.signal.removeEventListener("abort", abort);
      }
      waiting.add(run);
      if (!running) {
        running = true;
        queueMicrotask(advance);
      }
    });
}
