/**
 * Stable ID-derived, delay-only jitter for recurring-loop creation.
 * Implements PRD §5.9 and C-LOOP-04.
 */

import { MAX_LOOP_JITTER_MS } from "./constants.ts";

const FNV_OFFSET_BASIS = 0x81_1c_9d_c5;
const FNV_PRIME = 0x01_00_01_93;

export function deriveLoopJitterMs(loopId: string, cadenceIntervalMs: number): number {
  const cap = Math.min(Math.floor(cadenceIntervalMs / 10), MAX_LOOP_JITTER_MS);
  return hashLoopId(loopId) % (cap + 1);
}

function hashLoopId(loopId: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(loopId)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}
