/**
 * The ergonomic turn's timing defaults, and the gate built from them (PRD §5.8, C-API-48).
 * Separated from the `runTurn` runner (turn.ts) and the gate itself (turn-gate.ts) so all
 * three stay under the file-size cap and the defaults have ONE home.
 */

import { elwoodError } from "../errors.ts";
import { TurnGate } from "./turn-gate.ts";

/** Quiet window (ms) after `ready` for a no-oracle turn to settle once content stops. */
export const FALLBACK_QUIET_MS = 2_000;
/** Cap (ms) on the POST-`ready` transcript catch-up: a stalled flush bails, not hangs. */
const CATCH_UP_MS = 10_000;

/**
 * Arm the OPT-IN whole-turn ceiling, or nothing when the caller passed none (the default — a
 * live turn may run for hours). Armed only AFTER submission by the caller, so it can never
 * reject a prompt still queued behind readiness. Returns the timer to clear on settle.
 */
export function armTurnTimeout(
  timeoutMs: number | undefined,
  fail: (error: unknown) => void,
): ReturnType<typeof setTimeout> | undefined {
  if (timeoutMs === undefined) return undefined;
  const timer = setTimeout(() => fail(elwoodError("wait_timeout", "turn timed out")), timeoutMs);
  timer.unref?.(); // a pending ceiling must not keep the host alive by itself
  return timer;
}

/** The gate for one turn, with the runner's documented defaults applied to its options. */
export function gateForTurn(options: {
  readonly fallbackQuietMs?: number;
  readonly catchUpMs?: number;
  readonly maxPendingEvents?: number;
  readonly maxPendingBytes?: number;
}): TurnGate {
  return new TurnGate(
    options.fallbackQuietMs ?? FALLBACK_QUIET_MS,
    options.catchUpMs ?? CATCH_UP_MS,
    options.maxPendingEvents,
    options.maxPendingBytes,
  );
}
