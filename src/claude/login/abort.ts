/**
 * Deadline + lifecycle abort composition for the `/login` flow (PRD §5.3,
 * C-API-43). Every await in the driver races a single combined signal so the flow
 * settles on the FIRST of its overall deadline, a session-close abort, or the
 * awaited work itself — never hanging past the timeout or after termination.
 * Every helper removes its abort listener once it settles, so a long flow that
 * polls for minutes never pins listeners or pending promises on the signal.
 */

import { setTimeout as sleep } from "node:timers/promises";
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

/**
 * Race a promise against the combined signal so it can never outlast the deadline.
 * The abort listener is registered for the duration of the race only and removed
 * in `finally`, whichever side settles first.
 */
export async function raceSettle<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal);
  const rejection = Promise.withResolvers<never>();
  const onAbort = () => rejection.reject(abortError(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([work, rejection.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Sleep `ms`, or reject early with the typed abort error if the signal aborts.
 * The timer is unref'd and the abort listener is owned by the timer promise, so
 * both are released as soon as the sleep settles either way.
 */
export async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal, ref: false });
  } catch {
    // The only rejection `sleep` produces is the abort; surface it typed.
    throw abortError(signal);
  }
}

/** Sleep for one poll interval, or reject early if the signal aborts. */
export function pollDelay(signal: AbortSignal): Promise<void> {
  return abortableDelay(pollMs, signal);
}

/**
 * Hold until the session is not `blocked`, so a login keystroke never lands in a
 * blocking dialog (confirming its highlighted option) — dialog safety (C-API-43).
 * Aborts via the raced signal on timeout/close.
 */
export async function holdWhileBlocked(blocked: () => boolean, signal: AbortSignal): Promise<void> {
  while (blocked()) await pollDelay(signal);
}
