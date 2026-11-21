/** Reads the old native /usage text carried by assistant frames (PRD §5.12, C-STATS-05). */
import { isRecord } from "../../core/predicates.ts";
import type { UsageWindow } from "../../core/usage/types.ts";
import { fiveHourMinutes, weeklyMinutes, windowReadings } from "../../core/usage/windows.ts";
import { createLegacyResetReader } from "./legacy-reset.ts";

const subscriptionHeading =
  "You are currently using your subscription to power your Claude Code usage";
const overageHeading = "You are currently using your overages to power your Claude Code usage.";
const quotaRow =
  /^Current (session|week)(?: \(([^)]+)\))?: (\d+(?:\.\d+)?)% used(?: · resets (.+))?$/u;

export function legacyUsageWindows(message: unknown): UsageWindow[] {
  if (!(isRecord(message) && Array.isArray(message["content"]))) return [];
  const lines = message["content"].flatMap((block: unknown) => {
    if (!isRecord(block) || block["type"] !== "text" || typeof block["text"] !== "string")
      return [];
    return block["text"].split("\n").map((line) => line.trim());
  });
  if (!lines.some((line) => line === subscriptionHeading || line.startsWith(overageHeading)))
    return [];
  const readReset = createLegacyResetReader();
  return lines.flatMap((line) => {
    const match = quotaRow.exec(line);
    if (!match) return [];
    const [, period, scope, textPercent, reset] = match;
    const base = period === "session" ? "5-hour" : "Weekly";
    const label =
      scope === undefined || scope.toLowerCase() === "all models" ? base : `${base} (${scope})`;
    return windowReadings(
      label,
      Number(textPercent),
      readReset(reset),
      period === "session" ? fiveHourMinutes : weeklyMinutes,
    );
  });
}
