/**
 * What an adapter's turn boundary carries, and the accessors the runner reads it with.
 * Implements PRD §5.8 / §12A: the completeness signal, plus OPTIONAL evidence that the
 * agent itself rejected the turn. Separate from the reader contract so the failure shape
 * has one home (#19).
 */

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
