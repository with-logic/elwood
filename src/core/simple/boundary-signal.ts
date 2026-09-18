/**
 * What an adapter's turn boundary carries, and the accessors the runner reads it with.
 * Implements PRD §5.8 / §12A: the completeness signal, plus OPTIONAL evidence that the
 * agent itself rejected the turn. Separate from the reader contract so the failure shape
 * has one home (#19).
 */

import { type ElwoodError, elwoodError } from "../errors.ts";

/**
 * What a boundary carries. A bare string is the completeness signal on its own — the shorthand
 * every adapter uses today — while the object form additionally reports that the agent FAILED
 * the turn. The two are kept distinct because an empty response is NOT evidence of failure
 * (PRD §12A.3 allows a legitimately empty successful reply): only an adapter's own failure
 * evidence may set `failure`, never the absence of text.
 */
export type BoundarySignal = string | { readonly text: string; readonly failure: TurnFailure };

/** An adapter's evidence that the agent itself rejected the turn (PRD §12A.5). */
export type TurnFailure = {
  /** Human-readable reason, bounded by the adapter. */
  readonly message: string;
  /** Adapter-specific classification, DIAGNOSTIC ONLY — never used to decide failure. */
  readonly info?: string | undefined;
};
/** The expected-text half of a boundary signal, whichever form the adapter returned. */
export function boundaryText(signal: BoundarySignal): string {
  return typeof signal === "string" ? signal : signal.text;
}

/** The failure half, if the adapter reported one. Absent for every string-form signal. */
export function boundaryFailure(signal: BoundarySignal): TurnFailure | undefined {
  return typeof signal === "string" ? undefined : signal.failure;
}

/** The gate's expected text for a signal that may be absent: `undefined` stays `undefined`. */
export function boundaryExpectation(signal: BoundarySignal | undefined): string | undefined {
  return signal === undefined ? undefined : boundaryText(signal);
}

/**
 * NORMALIZES one adapter ACTIVITY event into failure evidence, for adapters whose rejection
 * never reaches a turn-boundary hook. Codex is exactly that case: a rejected turn writes
 * `task_complete` with an `error` payload to its transcript and fires NO `Stop` hook at all
 * (verified against codex-cli 0.155.0 — a bogus `--model` turn delivers only `SessionStart`
 * and `UserPromptSubmit`), so a hook-only reader could never observe it. `undefined` means
 * "no failure evidence here", which is every ordinary event.
 *
 * This is the transcript-side twin of `BoundarySignalReader`, and it carries the same rule:
 * only the adapter's OWN error payload may produce a `TurnFailure`. Silence, an empty reply,
 * or a missing message is NOT evidence of failure (PRD §12A.3).
 */
export type FailureEvidenceReader = (event: TurnFailureSource) => TurnFailure | undefined;

/**
 * The MINIMAL activity fields a failure-evidence reader may inspect: the adapter-neutral
 * `kind`/`label` plus the `raw` item the adapter attached. Deliberately loose (core must not
 * depend on adapter transcript types); each adapter narrows `raw` itself.
 */
export type TurnFailureSource = {
  readonly kind: string;
  readonly label: string;
  readonly raw?: unknown;
};

/**
 * The typed error for a turn the AGENT rejected: the adapter's reason as the message, and its
 * classification as DIAGNOSTIC-only `details.info` (never used to decide that a turn failed).
 */
export function turnFailedError(failure: TurnFailure): ElwoodError {
  return elwoodError("turn_failed", failure.message, {
    ...(failure.info === undefined ? {} : { info: failure.info }),
  });
}

/**
 * Builds the runner's "the agent rejected this turn" handler (C-API-57). Unlike a consumer-side
 * timeout the agent is DONE — it finished the turn by refusing it — so the serializer's boundary
 * is reached at once rather than waiting for a post-failure `ready`. The gate's failure is
 * idempotent, so repeated or late evidence cannot overwrite an already-committed outcome.
 */
export function rejectTurn(
  gate: { fail(error: unknown): void },
  boundary: { reach(): void },
): (failure: TurnFailure) => void {
  return (failure) => {
    gate.fail(turnFailedError(failure));
    boundary.reach();
  };
}

/**
 * Failure evidence carried by one ACTIVITY event, honoring the runner's turn binding. Two
 * properties must hold AT ONCE, and the binding state is what separates them:
 *
 * - A REJECTED turn usually produces no assistant content, so nothing has bound `turnId` when
 *   its `task_complete` arrives — yet the real event IS tagged (Codex sets `payload.turn_id`).
 *   While the turn is still UNBOUND the first tagged failure is therefore accepted: there is no
 *   other turn it could belong to, because the serializer holds the prior turn to its real
 *   boundary before this one starts.
 * - Once the turn IS bound, a differently tagged event belongs to a PRIOR turn, so a replayed or
 *   stale rejection is discarded rather than failing a healthy turn.
 *
 * Untagged evidence always belongs to the current turn. (Accepting the first tagged failure is
 * what #19 needs: filtering it out would resurrect the empty-success bug for the contentless
 * rejection that is the common case.)
 */
export function activityFailure(
  read: FailureEvidenceReader,
  event: TurnFailureSource & { readonly turnId?: string },
  turnId: string | undefined,
): TurnFailure | undefined {
  if (turnId !== undefined && event.turnId !== undefined && event.turnId !== turnId) {
    return undefined;
  }
  return read(event);
}

/** Failure evidence carried by a boundary signal, if the adapter reported one on the hook. */
export function signalFailure(signal: BoundarySignal | undefined): TurnFailure | undefined {
  return signal === undefined ? undefined : boundaryFailure(signal);
}
