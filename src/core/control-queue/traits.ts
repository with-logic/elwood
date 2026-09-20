/**
 * Static per-operation traits for the control queue: the kinds a session can
 * submit and their readiness/turn semantics. Split from the queue logic per the
 * repo convention of separating static tables from behavior (PRD §5.3).
 */

import type { Cancel, QueuedOperation } from "./types.ts";

export type ControlQueueError = () => Error;
/** How an operation's text is written to the terminal (not a domain name). */
export type ControlSubmitMode = "pasted_input" | "recovery_input" | "command";
export type ControlOperationKind =
  | "message"
  | "guidance"
  | "prompt"
  | "compact"
  | "list_models"
  | "set_model"
  | "login";

/**
 * When an operation may leave the readiness queue's holding lane.
 * - `"ready"`: only once the session is ready (ordinary messages, compact).
 * - `"always"`: immediately, even before readiness (prompts, picker commands).
 * - `"running_after_ready"`: once ready, OR — after the session has been ready
 *   at least once — during a live turn the caller is intervening in (guidance).
 */
export type ReadinessPolicy = "ready" | "always" | "running_after_ready";

/**
 * Whether an operation with this readiness policy may dispatch while the session
 * is not ready. Exhaustive over ReadinessPolicy with no runtime default (100%
 * coverage holds): a new member leaves a return-less path, so `noImplicitReturns`
 * fails the build rather than letting it silently become non-bypassable.
 */
function dispatchesWhileNotReady(policy: ReadinessPolicy, mayBypass: boolean): boolean {
  switch (policy) {
    case "always":
      return true;
    case "running_after_ready":
      return mayBypass;
    case "ready":
      return false;
  }
}

/** The bypass-eligibility shape `overtakesReadiness`/`nextDispatchIndex` read. */
export type OvertakeCandidate = {
  readonly kind: ControlOperationKind;
  readonly mayBypassReadiness: boolean;
};

/** Whether a queued operation may dispatch even though the session is not ready. */
export function overtakesReadiness(op: OvertakeCandidate): boolean {
  return dispatchesWhileNotReady(controlOperationTraits[op.kind].readiness, op.mayBypassReadiness);
}

/**
 * Index of the next operation to dispatch, or -1. Head dispatches when ready;
 * otherwise the first overtaker goes. `bypassable === 0` skips the scan when no
 * queued op can dispatch while not ready (keeps a message backlog amortized O(1)).
 */
export function nextDispatchIndex(
  queue: readonly OvertakeCandidate[],
  ready: boolean,
  bypassable: number,
): number {
  if (ready) return 0;
  if (overtakesReadiness(queue[0] as OvertakeCandidate)) return 0;
  if (bypassable === 0) return -1;
  return queue.findIndex(overtakesReadiness);
}

export type ControlOperationTraits = {
  // True when dispatching this operation submits `caller_submitted` evidence via
  // the queue's turn-started callback. This holds for guidance even when it
  // intervenes in an EXISTING turn, so it is named for its effect (reporting a
  // caller submission), not for "starting" a turn.
  readonly reportsCallerSubmission: boolean;
  readonly consumesReadiness: boolean;
  readonly readiness: ReadinessPolicy;
  readonly submitMode: ControlSubmitMode;
};

/**
 * Slash-command operations do not start a user turn, so no completion hook
 * will re-arm readiness afterwards; consuming readiness would deadlock later
 * sends. `guidance` is the only conditional policy: see `ReadinessPolicy`.
 */
export const controlOperationTraits: Readonly<
  Record<ControlOperationKind, ControlOperationTraits>
> = {
  message: {
    reportsCallerSubmission: true,
    consumesReadiness: true,
    readiness: "ready",
    submitMode: "pasted_input",
  },
  guidance: {
    reportsCallerSubmission: true,
    consumesReadiness: true,
    readiness: "running_after_ready",
    submitMode: "pasted_input",
  },
  prompt: {
    reportsCallerSubmission: true,
    consumesReadiness: true,
    readiness: "always",
    submitMode: "pasted_input",
  },
  compact: {
    reportsCallerSubmission: false,
    consumesReadiness: false,
    readiness: "ready",
    submitMode: "command",
  },
  list_models: {
    reportsCallerSubmission: false,
    consumesReadiness: false,
    readiness: "always",
    submitMode: "command",
  },
  set_model: {
    reportsCallerSubmission: false,
    consumesReadiness: false,
    readiness: "always",
    submitMode: "command",
  },
  // `/login` recovery: a picker command that must dispatch even while the session
  // is not ready (login has lapsed, so it may never reach `ready` on its own).
  login: {
    reportsCallerSubmission: false,
    consumesReadiness: false,
    readiness: "always",
    submitMode: "command",
  },
};

/** Owns abort-listener cleanup and the one in-flight cancellation marker. */
export class ControlCancellation {
  private readonly hooks = new Map<QueuedOperation, () => void>();
  private cancelled: { operation: QueuedOperation; error: Error } | undefined;

  listen(operation: QueuedOperation, cancel: Cancel, drop: (error: Error) => void): void {
    const listener = () => drop(cancel.error());
    cancel.signal.addEventListener("abort", listener, { once: true });
    this.hooks.set(operation, () => cancel.signal.removeEventListener("abort", listener));
    if (cancel.signal.aborted) listener();
  }

  mark(operation: QueuedOperation, error: Error): void {
    this.cancelled = { operation, error };
  }

  errorFor(operation: QueuedOperation): Error | undefined {
    return this.cancelled?.operation === operation ? this.cancelled.error : undefined;
  }

  remove(operation: QueuedOperation): void {
    this.hooks.get(operation)?.();
    this.hooks.delete(operation);
    if (this.cancelled?.operation === operation) this.cancelled = undefined;
  }

  clear(): void {
    this.cancelled = undefined;
  }
}
