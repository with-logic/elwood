/** Opt-in Claude quota diagnostics that keep native responses private (PRD §5.12). */
import { writeSync } from "node:fs";
import { runContained } from "../../core/contained.ts";

export const unverifiedSettingsMarker = "ELWOOD_QUOTA_SETTINGS_UNVERIFIED";

export function reportUnverifiedSettings(stderr: string): void {
  if (stderr.split("\n").includes(unverifiedSettingsMarker)) {
    logClaudeUsage("Could not verify Claude quota settings. Kept the configured credential.");
  }
}

export function logClaudeUsage(message: string): void {
  if (process.env["NODE_DEBUG"]?.split(/[\s,]+/u).includes("elwood")) {
    runContained(() => writeSync(2, `ELWOOD: ${message}\n`));
  }
}
