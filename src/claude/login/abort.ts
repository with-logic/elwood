/**
 * Deadline + lifecycle abort composition for the `/login` flow (PRD §5.3,
 * C-API-43). Every await in the driver races a single combined signal so the flow
 * settles on the FIRST of its overall deadline, a session-close abort, or the
 * awaited work itself — never hanging past the timeout or after termination.
 */

import { elwoodError } from "../../core/errors.ts";

const pollMs = 100;

export type DeadlineSignal = {
  /** Aborts on the deadline OR the parent lifecycle signal (whichever first). */
  readonly signal: AbortSignal;
  /** Clears the deadline timer; call once the flow settles. */
  readonly cancel: () => void;
};

/** Build a signal that aborts on `timeoutMs` elapsing or `parent` aborting. */
export function deadlineSignal(timeoutMs: number, parent: AbortSignal): DeadlineSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("deadline"), timeoutMs);
  timer.unref?.();
  const onParent = () => controller.abort("aborted");
  if (parent.aborted) onParent();
  else parent.addEventListener("abort", onParent, { once: true });
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParent);
    },
  };
}

/** The typed error a combined signal's abort should surface. */
export function abortError(signal: AbortSignal): Error {
  return signal.reason === "aborted"
    ? elwoodError("session_not_running", "The session terminated during /login.")
    : elwoodError("login_timeout", "Claude /login did not complete in time.");
}

/** Reject as soon as `signal` aborts; used to race against interactive awaits. */
export function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
  });
}

/** Race a promise against the combined signal so it can never outlast the deadline. */
export function raceSettle<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([work, abortRejection(signal)]);
}

/** Sleep for one poll interval, or reject early if the signal aborts. */
export function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(resolve, pollMs);
    timer.unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError(signal));
      },
      { once: true },
    );
  });
}
