/**
 * Backlog bounds for one ergonomic turn's gate (PRD §5.8, C-API-53). Separated from
 * `turn-gate.ts` so both stay under the file-size cap and the tunables have ONE home.
 */

/**
 * Cap on UNCONSUMED events buffered for a slow/paused consumer; past it the turn fails with a
 * typed `wait_timeout` rather than growing without limit (a turn has no default whole-turn
 * timeout). Large enough that a normally draining consumer never hits it.
 */
export const MAX_PENDING_EVENTS = 100_000;

/**
 * Compact the consumed prefix only past this many consumed events (so a small stream never
 * churns splice on tiny arrays); the `head >= length/2` gate then keeps it amortised O(1).
 */
export const HEAD_COMPACT_MIN = 32;

/**
 * Cap on UNCONSUMED UTF-8 bytes for a slow consumer. The count cap alone cannot bound memory —
 * a single event may carry an arbitrarily large agent-controlled string — so this byte
 * high-water is the real exhaustion guard. 64 MiB: far above any legitimate backlog.
 */
export const MAX_PENDING_BYTES = 64 * 1024 * 1024;
