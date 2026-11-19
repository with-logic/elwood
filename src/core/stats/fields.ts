/** Validated optional native counters (PRD §5.12, C-STATS-01). */

import { isFiniteNumber, isNonnegativeSafeInteger } from "../predicates.ts";

export function count(value: unknown): number | undefined {
  return isNonnegativeSafeInteger(value) ? value : undefined;
}

export function quotaPercentages(used: unknown) {
  if (!isFiniteNumber(used) || used < 0) return undefined;
  return { usedPercent: used, remainingPercent: Math.max(0, 100 - used) };
}
