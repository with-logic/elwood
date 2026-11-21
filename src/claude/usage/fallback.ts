/** Reads the structured or text report from an isolated Claude /usage probe (C-STATS-05). */
import { isRecord } from "../../core/predicates.ts";
import type { UsageWindow } from "../../core/usage/types.ts";
import { logClaudeUsage } from "./diagnostics.ts";
import { legacyUsageWindows } from "./legacy.ts";
import { claudeWindows } from "./windows.ts";

export function readClaudeFallback(stdout: string | undefined): readonly UsageWindow[] {
  const windows = stdout === undefined ? [] : claudeFallbackWindows(stdout);
  let message = "Claude account usage fallback succeeded.";
  if (windows.length === 0) {
    message =
      stdout === undefined
        ? "Claude account usage fallback failed."
        : "Unrecognized Claude account usage fallback report.";
  }
  logClaudeUsage(message);
  return windows;
}

export function claudeFallbackWindows(stdout: string): readonly UsageWindow[] {
  let legacy: readonly UsageWindow[] = [];
  for (const frame of assistantFrames(stdout)) {
    const report = frame["usage_report"];
    if (report !== undefined) {
      if (!isRecord(report)) return [];
      const windows = claudeWindows({
        rate_limits_available: true,
        rate_limits: report["rate_limits"],
      });
      if (windows.length > 0) return windows;
    }
    if (legacy.length === 0) legacy = legacyUsageWindows(frame["message"]);
  }
  return legacy;
}

function* assistantFrames(stdout: string): Generator<Readonly<Record<string, unknown>>> {
  for (const line of stdout.trimEnd().split("\n")) {
    try {
      const frame: unknown = JSON.parse(line);
      if (isRecord(frame) && frame["type"] === "assistant") yield frame;
    } catch {
      // The native CLI may include text diagnostics in its stream.
    }
  }
}
