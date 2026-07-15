/**
 * Static per-operation traits for the control queue: the kinds a session can
 * submit and their readiness/turn semantics. Split from the queue logic per the
 * repo convention of separating static tables from behavior (PRD §5.3).
 */

export type ControlQueueError = () => Error;
/** How an operation's text is written to the terminal (not a domain name). */
export type ControlSubmitMode = "pasted_input" | "command";
export type ControlOperationKind =
  | "message"
  | "guidance"
  | "prompt"
  | "compact"
  | "list_models"
  | "set_model";

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
export function dispatchesWhileNotReady(policy: ReadinessPolicy, mayBypass: boolean): boolean {
  switch (policy) {
    case "always":
      return true;
    case "running_after_ready":
      return mayBypass;
    case "ready":
      return false;
  }
}

/** Whether a queued operation may dispatch even though the session is not ready. */
export function overtakesReadiness(op: {
  readonly kind: ControlOperationKind;
  readonly mayBypassReadiness: boolean;
}): boolean {
  return dispatchesWhileNotReady(controlOperationTraits[op.kind].readiness, op.mayBypassReadiness);
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
};
