/** Validated optional native counters (PRD §5.12, C-STATS-01). */

import { isFiniteNumber, isNonnegativeSafeInteger } from "../predicates.ts";

export function count(value: unknown): number | undefined {
  return isNonnegativeSafeInteger(value) ? value : undefined;
}

/** Preserve usage above 100 percent. An account at 104 percent used has zero remaining. */
export function quotaPercentages(usedPercent: unknown) {
  if (!isFiniteNumber(usedPercent) || usedPercent < 0) return undefined;
  return { usedPercent, remainingPercent: Math.max(0, 100 - usedPercent) };
}
