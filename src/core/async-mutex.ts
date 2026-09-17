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
  return <T>(task: () => Promise<T>, cancel?: MutexCancel): Promise<T> => {
    const run = tail.then(() => {
      // Checked at the moment the turn is acquired: a waiter whose session closed while
      // the lock was held must not run its task, so it never takes the critical section.
      if (cancel?.signal.aborted === true) throw cancel.error();
      return task();
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    // The WAIT itself is also cut short, so the caller learns at once rather than after the
    // holder finishes. The tail still follows `run`, so the lock's ordering is unaffected.
    if (cancel === undefined) return run;
    return Promise.race([run, cancelled(cancel, run)]);
  };
}

/**
 * Rejects as soon as `cancel` aborts; never leaks a listener once `run` settles.
 * An already-aborted signal needs no separate check: `addEventListener` invokes the
 * listener immediately in that case.
 */
function cancelled<T>(cancel: MutexCancel, run: Promise<T>): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    const onAbort = (): void => reject(cancel.error());
    cancel.signal.addEventListener("abort", onAbort, { once: true });
    void run
      .catch(() => undefined)
      .finally(() => {
        cancel.signal.removeEventListener("abort", onAbort);
      });
  });
}
