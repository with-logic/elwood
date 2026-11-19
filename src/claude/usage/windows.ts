/** Project Claude's on-demand get_usage result into named quota windows (PRD §5.12). */
import { isRecord } from "../../core/predicates.ts";
import type { UsageWindow } from "../../core/usage/types.ts";
import { isoInstant, windowReadings } from "../../core/usage/windows.ts";

function scopeLabel(scope: unknown): string {
  if (!isRecord(scope)) return "";
  return [scope["model"], scope["surface"]]
    .flatMap((item) =>
      isRecord(item) && typeof item["display_name"] === "string" ? [item["display_name"]] : [],
    )
    .join(" / ");
}

function windowsFromNativeRow(row: unknown): UsageWindow[] {
  if (!isRecord(row) || typeof row["kind"] !== "string") return [];
  const minutes = row["kind"] === "session" ? 300 : row["group"] === "weekly" ? 10080 : undefined;
  const period = minutes === 300 ? "5-hour" : minutes === 10080 ? "Weekly" : row["kind"];
  const scope = scopeLabel(row["scope"]);
  return windowReadings(
    scope ? `${period} (${scope})` : period,
    row["percent"],
    isoInstant(row["resets_at"]),
    minutes,
  );
}

export function claudeWindows(reply: unknown): UsageWindow[] {
  if (
    !isRecord(reply) ||
    reply["rate_limits_available"] !== true ||
    !isRecord(reply["rate_limits"])
  )
    return [];
  const limits = reply["rate_limits"];
  if (Array.isArray(limits["limits"])) return limits["limits"].flatMap(windowsFromNativeRow);
  const legacyLabels = {
    five_hour: "5-hour",
    seven_day: "Weekly",
    seven_day_oauth_apps: "Weekly (OAuth apps)",
    seven_day_opus: "Weekly (Opus)",
    seven_day_sonnet: "Weekly (Sonnet)",
    seven_day_cowork: "Weekly (Cowork)",
  };
  const windows = Object.entries(legacyLabels).flatMap(([key, label]) => {
    const row = limits[key];
    return isRecord(row)
      ? windowReadings(
          label,
          row["utilization"],
          isoInstant(row["resets_at"]),
          key === "five_hour" ? 300 : 10080,
        )
      : [];
  });
  if (Array.isArray(limits["model_scoped"])) {
    for (const row of limits["model_scoped"]) {
      if (!isRecord(row) || typeof row["display_name"] !== "string") continue;
      const label = `Weekly (${row["display_name"]})`;
      if (!windows.some((window) => window.label === label)) {
        windows.push(
          ...windowReadings(label, row["utilization"], isoInstant(row["resets_at"]), 10080),
        );
      }
    }
  }
  return windows;
}
