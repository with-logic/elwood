/**
 * Joins concurrent process-table reads into one, for a fleet of sessions shutting down
 * together (PRD §5.3 and §9.4, C-LIFE-10). Each still gets its own timeout.
 */

/**
 * Joins every request made before a listing starts into that one listing, so a fleet
 * shutting down together runs one `ps` instead of one per session. A request never
 * joins a listing that has already started: each sweep needs a table read after its
 * own leader was frozen. The listing starts on the next turn of the event loop and may
 * run for the largest timeout any of its requests asked for, while each request still
 * rejects with `ETIMEDOUT` at its own timeout: one session's nearly spent deadline never
 * cuts short another's read.
 */
export function coalesceUnstarted<T>(
  run: (timeoutMs: number) => Promise<T>,
): (timeoutMs: number) => Promise<T> {
  type Batch = { timeoutMs: number; readonly result: Promise<T> };
  let open: Batch | undefined;
  const startBatch = (timeoutMs: number): Batch => {
    const { promise: started, resolve: start } = Promise.withResolvers<void>();
    const batch: Batch = { timeoutMs, result: started.then(() => run(batch.timeoutMs)) };
    setImmediate(() => {
      open = undefined;
      start();
    });
    return batch;
  };
  return (timeoutMs) => {
    open ??= startBatch(timeoutMs);
    open.timeoutMs = Math.max(open.timeoutMs, timeoutMs);
    return withinOwnTimeout(open.result, timeoutMs);
  };
}

/** `result`, or an `ETIMEDOUT` rejection once `timeoutMs` passes first. */
function withinOwnTimeout<T>(result: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error("process table read timed out"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
  });
  return Promise.race([result, timedOut]).finally(() => clearTimeout(timer));
}
