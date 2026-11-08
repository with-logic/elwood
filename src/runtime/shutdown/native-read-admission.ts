/** Shared native scan/probe admission within each read's existing deadline (C-LIFE-10). */

import type { PsRunner } from "./process-table.ts";
import { processReadTimeout } from "./read-timeout.ts";

/**
 * Two lets native reads overlap while bounding subprocess load across sessions.
 * PATH_READS_AT_ONCE separately batches one walk's logical requests; those requests
 * compete for these shared slots, so the independent bounds need not match.
 */
export const MAX_NATIVE_PROCESS_READS = 2;
const waiting = new Map<symbol, () => void>();
let active = 0;

/** Every adapter shares the same admission owner and forwards only its remaining native budget. */
export function createAdmittedPsRunner(
  run: PsRunner,
  options: { readonly ref?: boolean } = {},
): PsRunner {
  return (file, args, bounds) =>
    admitNativeProcessRead(
      bounds.timeout,
      (remainingMs) => run(file, args, { ...bounds, timeout: remainingMs }),
      options,
    );
}

/** Queue only the native launch, after coalescing; never release before its runner settles. */
export function admitNativeProcessRead<T>(
  timeoutMs: number,
  launch: (remainingMs: number) => Promise<T>,
  { ref = true }: { readonly ref?: boolean } = {},
): Promise<T> {
  return reserveNativeProcessRead(performance.now() + timeoutMs, launch, { ref }).result;
}

/** A pending FIFO position whose still-live consumers may extend its deadline. */
export type NativeReadReservation<T> = {
  readonly result: Promise<T>;
  readonly extendUntil: (deadline: number) => void;
  readonly cancel: () => void;
};

/** Reserve once; deadline updates never move the entry or affect an already-started runner. */
export function reserveNativeProcessRead<T>(
  until: number,
  launch: (remainingMs: number) => Promise<T>,
  { ref = true }: { readonly ref?: boolean } = {},
): NativeReadReservation<T> {
  let deadline = until;
  const key = Symbol();
  const { promise: result, resolve, reject } = Promise.withResolvers<T>();
  let timer: NodeJS.Timeout;
  const expire = () => {
    waiting.delete(key);
    reject(timedOut());
  };
  const arm = () => {
    timer = setTimeout(expire, Math.max(0, deadline - performance.now()));
    if (!ref) timer.unref();
  };
  arm();
  waiting.set(key, () => {
    clearTimeout(timer);
    const remainingMs = Math.ceil(deadline - performance.now());
    if (remainingMs <= 0) return reject(timedOut());
    active += 1;
    try {
      void launch(remainingMs).then(
        (value) => {
          active -= 1;
          resolve(value);
          drain();
        },
        (error: unknown) => {
          active -= 1;
          reject(error);
          drain();
        },
      );
    } catch (error) {
      active -= 1;
      reject(error);
    }
  });
  drain();
  return {
    result,
    extendUntil: (next) => {
      if (!waiting.has(key)) return;
      deadline = Math.max(deadline, next);
      clearTimeout(timer);
      arm();
    },
    cancel: () => {
      if (!waiting.delete(key)) return;
      clearTimeout(timer);
      reject(timedOut());
    },
  };
}

/** FIFO admission; expired entries remove themselves without reserving capacity. */
function drain(): void {
  while (active < MAX_NATIVE_PROCESS_READS) {
    const next = waiting.entries().next().value;
    if (next === undefined) return;
    waiting.delete(next[0]);
    next[1]();
  }
}

function timedOut(): Error {
  return processReadTimeout("process read admission timed out");
}
