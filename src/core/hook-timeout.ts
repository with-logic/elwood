/**
 * Timeout race for hook dispatch that structurally distinguishes a genuine
 * timeout from a handler that throws or rejects.
 * Implements PRD §6.3 (timeout category and timeoutMs telemetry).
 */

/**
 * Result of racing a hook handler against its timeout. A genuine timeout is a
 * distinct variant so it can never be confused with a handler that itself throws
 * `new Error("timeout")`: that handler still rejects `raceHookTimeout`, taking
 * the caller's error path and the `handler_error` category. `timeoutMs` is only
 * meaningful — and only attached by callers — on the `timedOut: true` branch.
 */
export type HookTimeoutResult<T> =
  | { readonly timedOut: false; readonly value: T }
  | { readonly timedOut: true };

/**
 * Resolves with the handler value if it settles before `timeoutMs`, or with a
 * tagged timeout result if the timer wins. Rejects only when the handler itself
 * rejects, so a handler error is never misreported as a timeout.
 */
export async function raceHookTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<HookTimeoutResult<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<HookTimeoutResult<T>>((resolve) => {
    timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then((value): HookTimeoutResult<T> => ({ timedOut: false, value })),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
