/** Project Codex App Server and transcript quota windows (PRD §5.12). */
import { isNonnegativeSafeInteger, isRecord } from "../../core/predicates.ts";
import { quotaPercentages } from "../../core/stats/fields.ts";
import type { CodexRateLimits } from "../../core/stats/types.ts";
import type { UsageWindow, UsageWindows } from "../../core/usage/types.ts";
import { resetFromSeconds, usageWindow, weeklyMinutes } from "../../core/usage/windows.ts";

const slots = ["primary", "secondary"] as const;
type Slot = (typeof slots)[number];

function durationLabel(minutes: unknown, slot: Slot): string {
  if (minutes === weeklyMinutes) return "Weekly";
  if (!isNonnegativeSafeInteger(minutes) || minutes === 0) return slot;
  return minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
}

function windowLabel(minutes: unknown, slot: Slot, bucket: string | undefined): string {
  const period = durationLabel(minutes, slot);
  return bucket ? `${period} (${bucket})` : period;
}

function projectWindow(
  slot: Slot,
  bucket: string | undefined,
  percentages: Pick<UsageWindow, "usedPercent" | "remainingPercent">,
  minutes: unknown,
  resetSeconds: unknown,
): UsageWindow {
  return usageWindow(
    windowLabel(minutes, slot, bucket),
    percentages,
    resetFromSeconds(resetSeconds),
    minutes,
  );
}

function bucketWindows(value: unknown, bucket: string): UsageWindow[] {
  if (!isRecord(value)) return [];
  return slots.flatMap((slot) => {
    const row = value[slot];
    if (!isRecord(row)) return [];
    const percentages = quotaPercentages(row["usedPercent"]);
    return percentages
      ? [projectWindow(slot, bucket, percentages, row["windowDurationMins"], row["resetsAt"])]
      : [];
  });
}

export function codexTranscriptWindows(limits: CodexRateLimits): UsageWindows {
  const { primary, secondary, limitId } = limits;
  if (primary === undefined)
    return [
      projectWindow(
        "secondary",
        limitId,
        secondary,
        secondary.windowMinutes,
        secondary.resetsAtUnixSeconds,
      ),
    ];
  const first = projectWindow(
    "primary",
    limitId,
    primary,
    primary.windowMinutes,
    primary.resetsAtUnixSeconds,
  );
  return secondary === undefined
    ? [first]
    : [
        first,
        projectWindow(
          "secondary",
          limitId,
          secondary,
          secondary.windowMinutes,
          secondary.resetsAtUnixSeconds,
        ),
      ];
}

export function codexAppServerWindows(reply: unknown): UsageWindow[] {
  if (!isRecord(reply)) return [];
  const buckets = reply["rateLimitsByLimitId"];
  if (isRecord(buckets) && Object.keys(buckets).length > 0) {
    return Object.entries(buckets).flatMap(([id, value]) => bucketWindows(value, id));
  }
  const fallback = reply["rateLimits"];
  return bucketWindows(
    fallback,
    isRecord(fallback) && typeof fallback["limitId"] === "string" ? fallback["limitId"] : "",
  );
}
