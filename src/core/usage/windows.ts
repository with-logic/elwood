/** Validate provider percentages and reset times (PRD §5.12, C-STATS-01/03). */
import { optional } from "../optional.ts";
import { isFiniteNumber, isNonnegativeSafeInteger } from "../predicates.ts";
import type { UsageWindow } from "./types.ts";

export function isoInstant(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    return undefined;
  // Date.parse silently carries February 30 into March.
  const day = value.slice(0, 10);
  return new Date(day).toISOString().startsWith(day) ? value : undefined;
}

export function resetFromSeconds(value: unknown): string | undefined {
  if (!isNonnegativeSafeInteger(value) || value > 8_640_000_000_000) return undefined;
  return new Date(value * 1000).toISOString();
}

export function windowReading(
  label: string,
  used: unknown,
  reset: string | undefined,
  minutes?: unknown,
): UsageWindow[] {
  if (!isFiniteNumber(used) || used < 0) return [];
  return [
    {
      label,
      ...optional(
        isNonnegativeSafeInteger(minutes) && minutes > 0 ? minutes : undefined,
        "windowMinutes",
      ),
      usedPercent: used,
      remainingPercent: Math.max(0, 100 - used),
      ...optional(reset, "resetsAt"),
    },
  ];
}
