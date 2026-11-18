/** Validated optional native counters (PRD §5.12, C-STATS-01). */

import { isNonnegativeSafeInteger } from "../predicates.ts";

export function count(value: unknown): number | undefined {
  return isNonnegativeSafeInteger(value) ? value : undefined;
}
