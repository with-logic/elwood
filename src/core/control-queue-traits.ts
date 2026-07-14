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

export type ControlOperationTraits = {
  readonly startsTurn: boolean;
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
    startsTurn: true,
    consumesReadiness: true,
    readiness: "ready",
    submitMode: "pasted_input",
  },
  guidance: {
    startsTurn: true,
    consumesReadiness: true,
    readiness: "running_after_ready",
    submitMode: "pasted_input",
  },
  prompt: {
    startsTurn: true,
    consumesReadiness: true,
    readiness: "always",
    submitMode: "pasted_input",
  },
  compact: {
    startsTurn: false,
    consumesReadiness: false,
    readiness: "ready",
    submitMode: "command",
  },
  list_models: {
    startsTurn: false,
    consumesReadiness: false,
    readiness: "always",
    submitMode: "command",
  },
  set_model: {
    startsTurn: false,
    consumesReadiness: false,
    readiness: "always",
    submitMode: "command",
  },
};
