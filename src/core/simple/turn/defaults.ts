/**
 * The ergonomic turn's timing defaults, and the gate built from them (PRD §5.8, C-API-48).
 * Separated from the `runTurn` runner (turn.ts) and the gate itself (turn-gate.ts) so all
 * three stay under the file-size cap and the defaults have ONE home.
 *
 * A turn may run for HOURS (a test suite, a PR poll), so there is NO whole-turn timeout by
 * default; callers may pass an opt-in `timeoutMs`, armed only AFTER submission (a turn begins on
 * submission — the timer must never reject a caller for a prompt still queued behind readiness
 * that then submits anyway). The tight cap is `catchUpMs`, armed only ONCE `ready` fires: the
 * flush should be near-instant, so a longer stall rejects with `wait_timeout`.
 */

import { elwoodError } from "../../errors.ts";
import { TurnGate } from "../turn-gate.ts";
import type { StreamTurnOptions } from "../turn-types.ts";

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
export function gateForTurn(
  options: Pick<
    StreamTurnOptions,
    "fallbackQuietMs" | "catchUpMs" | "maxPendingEvents" | "maxPendingBytes"
  >,
): TurnGate {
  return new TurnGate(
    options.fallbackQuietMs ?? FALLBACK_QUIET_MS,
    options.catchUpMs ?? CATCH_UP_MS,
    options.maxPendingEvents,
    options.maxPendingBytes,
  );
}
