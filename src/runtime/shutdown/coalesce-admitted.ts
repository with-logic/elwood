/** Shares queued native snapshots without reusing started reads (PRD §5.3, C-LIFE-10). */
import { type NativeReadReservation, reserveNativeProcessRead } from "./native-read-admission.ts";
import { processReadTimeout } from "./read-timeout.ts";

/** Native capacity is acquired before the batch closes; every consumer owns its deadline. */
export function coalesceAdmittedReads<T>(
  run: (timeoutMs: number) => Promise<T>,
  { ref = true }: { readonly ref?: boolean } = {},
): (timeoutMs: number) => Promise<T> {
  type Consumer = {
    until: number;
    timer: NodeJS.Timeout;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  };
  type Batch = {
    until: number;
    consumers: Set<Consumer>;
    starting: NodeJS.Immediate | undefined;
    reservation: NativeReadReservation<T> | undefined;
  };
  let open: Batch | undefined;
  const finish = (batch: Batch, complete: (consumer: Consumer) => void) => {
    if (open === batch) open = undefined;
    for (const consumer of batch.consumers) {
      clearTimeout(consumer.timer);
      if (performance.now() >= consumer.until) consumer.reject(timedOut());
      else complete(consumer);
    }
    batch.consumers.clear();
  };
  const abandon = (batch: Batch) => {
    clearImmediate(batch.starting);
    batch.reservation?.cancel();
    open = undefined;
    for (const consumer of batch.consumers) {
      clearTimeout(consumer.timer);
      consumer.reject(timedOut());
    }
    batch.consumers.clear();
  };
  const create = (until: number): Batch => {
    const batch: Batch = {
      until,
      consumers: new Set(),
      starting: undefined,
      reservation: undefined,
    };
    batch.starting = setImmediate(() => {
      batch.starting = undefined;
      batch.reservation = reserveNativeProcessRead(
        batch.until,
        (remaining) => {
          open = undefined;
          return run(remaining);
        },
        { ref },
      );
      void batch.reservation.result.then(
        (value) => finish(batch, (consumer) => consumer.resolve(value)),
        (error) => finish(batch, (consumer) => consumer.reject(error)),
      );
    });
    if (!ref) batch.starting.unref();
    return batch;
  };
  return (timeoutMs) => {
    const now = performance.now();
    if (open !== undefined && open.until <= now) abandon(open);
    open ??= create(now + timeoutMs);
    const batch = open;
    batch.until = Math.max(batch.until, now + timeoutMs);
    return new Promise<T>((resolve, reject) => {
      const consumer: Consumer = {
        until: now + timeoutMs,
        timer: setTimeout(() => {
          batch.consumers.delete(consumer);
          reject(timedOut());
          if (batch.consumers.size === 0 && open === batch) abandon(batch);
        }, timeoutMs),
        resolve,
        reject,
      };
      if (!ref) consumer.timer.unref();
      batch.consumers.add(consumer);
      batch.reservation?.extendUntil(batch.until);
    });
  };
}

function timedOut(): Error {
  return processReadTimeout("process table read timed out");
}
