/**
 * Shared bounds for recurring session loops.
 * Implements PRD §5.9 and C-LOOP-03/C-LOOP-04.
 */

export const MAX_ACTIVE_LOOPS = 50;
export const MIN_LOOP_MESSAGE_BYTES = 1;
export const MAX_LOOP_MESSAGE_BYTES = 65_536;
export const MIN_LOOP_INTERVAL_MS = 60_000;
export const MAX_LOOP_INTERVAL_MS = 604_800_000;
export const IDLE_LOOP_INTERVAL_MS = 300_000;
export const MAX_LOOP_JITTER_MS = 30_000;
export const LOOP_EXPIRATION_MS = 604_800_000;
