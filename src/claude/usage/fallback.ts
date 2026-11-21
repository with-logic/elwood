/** Reads the structured or text report from an isolated Claude /usage probe (C-STATS-05). */
import { writeSync } from "node:fs";
import { runContained } from "../../core/contained.ts";
import { isRecord } from "../../core/predicates.ts";
import type { UsageWindow } from "../../core/usage/types.ts";
import { legacyUsageWindows } from "./legacy.ts";
import { claudeWindows } from "./windows.ts";

export function readClaudeFallback(stdout: string | undefined): readonly UsageWindow[] {
  const windows = stdout === undefined ? [] : claudeFallbackWindows(stdout);
  if (windows.length === 0 && process.env["NODE_DEBUG"]?.split(/[\s,]+/u).includes("elwood")) {
    const message =
      stdout === undefined
        ? "Claude account usage fallback failed."
        : "Unrecognized Claude account usage fallback report.";
    runContained(() => writeSync(2, `ELWOOD: ${message}\n`));
  }
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
