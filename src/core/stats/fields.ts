/** Validated optional native counters (PRD §5.12, C-STATS-01). */

export function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
