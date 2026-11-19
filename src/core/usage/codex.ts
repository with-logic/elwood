/** Project Codex account/rateLimits/read buckets, independent of transcript writes (PRD §5.12). */
import { isNonnegativeSafeInteger, isRecord } from "../predicates.ts";
import type { UsageWindow } from "./types.ts";
import { resetFromSeconds, windowReading } from "./windows.ts";

function durationLabel(minutes: unknown, slot: string): string {
  if (minutes === 10080) return "Weekly";
  if (!isNonnegativeSafeInteger(minutes) || minutes === 0) return slot;
  return minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
}

function bucketWindows(value: unknown, bucket: string): UsageWindow[] {
  if (!isRecord(value)) return [];
  return ["primary", "secondary"].flatMap((slot) => {
    const row = value[slot];
    if (!isRecord(row)) return [];
    const period = durationLabel(row["windowDurationMins"], slot);
    const label = bucket ? `${period} (${bucket})` : period;
    return windowReading(
      label,
      row["usedPercent"],
      resetFromSeconds(row["resetsAt"]),
      row["windowDurationMins"],
    );
  });
}

export function codexWindows(reply: unknown): UsageWindow[] {
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
