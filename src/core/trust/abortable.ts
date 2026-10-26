/**
 * Abortable waits that end with their trust attempt (PRD §5.4, C-TRUST-01): each resolves
 * false once the attempt's signal aborts, so no write or timer outlives the attempt.
 */
import type { TrustWriteResult } from "./types.ts";

/** Race disposal against an in-flight write while retaining a rejection handler for it. */
export function ownWrite(signal: AbortSignal, write: TrustWriteResult): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const cancel = () => resolve(false);
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve(write).then(
      () => {
        signal.removeEventListener("abort", cancel);
        resolve(!signal.aborted);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
  });
}

/** Resolves true after `ms`. */
export function abortableDelay(signal: AbortSignal, ms: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const cancel = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve(true);
    }, ms);
    timer.unref();
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/** Resolves true when the `wake` handed to `arm` runs; holds no timer while it waits. */
export function untilWoken(signal: AbortSignal, arm: (wake: () => void) => void): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const end = () => resolve(false);
    signal.addEventListener("abort", end, { once: true });
    arm(() => {
      signal.removeEventListener("abort", end);
      resolve(true);
    });
  });
}
