/**
 * What an adapter's turn boundary carries, and the accessors the runner reads it with.
 * Implements PRD §5.8 / §10 / §12A and C-API-59 / C-API-60: the completeness signal, plus
 * OPTIONAL evidence that the agent itself rejected the turn, surfaced as `turn_failed`.
 * Separate from the reader contract so the failure shape has one home.
 */

import { type ElwoodError, elwoodError } from "../errors.ts";
import type { TurnGate } from "./turn-gate.ts";
import type { TurnBoundaryHook } from "./turn-types.ts";

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
  /** The agent's own error name (Claude's `error`), DIAGNOSTIC ONLY — never decides failure. */
  readonly agentError?: string | undefined;
  /**
   * Whether the rejection names the submission the turn accepted (the hook that accepted it).
   * A late rejection of an earlier turn can arrive during a later one, so the adapter, which
   * alone knows its submission identity, says whether it is this turn's. Absent: the adapter
   * cannot tell, and the rejection is taken as the turn's own once the turn has accepted.
   */
  readonly belongsTo?: (acceptedBy: TurnBoundaryHook) => boolean;
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

/** The failure a signal reports, if any; `undefined` for an absent or string-form signal. */
export function signalFailure(signal: BoundarySignal | undefined): TurnFailure | undefined {
  return signal === undefined ? undefined : boundaryFailure(signal);
}

/** The consumer-facing `turn_failed` error for an adapter's rejection evidence (C-API-59). */
export function turnRejection(failure: TurnFailure): ElwoodError {
  const details = failure.agentError === undefined ? {} : { agentError: failure.agentError };
  return elwoodError("turn_failed", failure.message, details);
}

type BoundaryGate = Pick<TurnGate, "fail" | "expectText">;

/**
 * An untagged hook's boundary: its text is the completeness oracle, or its rejection fails the
 * turn. An earlier turn's late rejection is not this turn's: only a rejection after this turn's
 * own submission, which the adapter matches to it, fails the turn (C-API-59).
 */
export function settleHookBoundary(
  gate: BoundaryGate,
  signal: BoundarySignal | undefined,
  acceptedBy: TurnBoundaryHook | undefined,
): void {
  const failure = signalFailure(signal);
  if (!failure) gate.expectText(boundaryExpectation(signal));
  else if (acceptedBy && (failure.belongsTo?.(acceptedBy) ?? true))
    gate.fail(turnRejection(failure));
}

/**
 * A native boundary already names this turn (its identity matched the turn id), so its
 * rejection fails the turn outright; otherwise its text is the completeness oracle (C-API-60).
 */
export function settleNativeBoundary(gate: BoundaryGate, signal: BoundarySignal): void {
  const failure = boundaryFailure(signal);
  if (failure) gate.fail(turnRejection(failure));
  else gate.expectText(boundaryText(signal));
}

const maxDiagnosticLength = 2_000;

/** A nonblank agent diagnostic, bounded so a rejection message stays small (§6.1). */
export function boundedDiagnostic(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.length <= maxDiagnosticLength ? value : `${value.slice(0, maxDiagnosticLength)}…`;
}
