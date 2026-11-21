/** Validate provider percentages and reset times (PRD §5.12, C-STATS-01/03). */
import { optional } from "../optional.ts";
import { isNonnegativeSafeInteger } from "../predicates.ts";
import { quotaPercentages } from "../stats/fields.ts";
import type { UsageWindow } from "./types.ts";

export const fiveHourMinutes = 5 * 60;
export const weeklyMinutes = 7 * 24 * 60;
// Date accepts at most 8.64e15 milliseconds from the epoch.
const maxEpochSeconds = 8_640_000_000_000;

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
  if (!isNonnegativeSafeInteger(value) || value > maxEpochSeconds) return undefined;
  return new Date(value * 1000).toISOString();
}

export function windowReadings(
  label: string,
  usedPercent: unknown,
  reset: string | undefined,
  minutes?: unknown,
): UsageWindow[] {
  const percentages = quotaPercentages(usedPercent);
  return percentages ? [usageWindow(label, percentages, reset, minutes)] : [];
}

export function usageWindow(
  label: string,
  percentages: Pick<UsageWindow, "usedPercent" | "remainingPercent">,
  reset: string | undefined,
  minutes: unknown,
): UsageWindow {
  const { usedPercent, remainingPercent } = percentages;
  return {
    label,
    ...optional(
      isNonnegativeSafeInteger(minutes) && minutes > 0 ? minutes : undefined,
      "windowMinutes",
    ),
    usedPercent,
    remainingPercent,
    ...optional(reset, "resetsAt"),
  };
}
