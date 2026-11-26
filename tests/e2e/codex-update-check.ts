/**
 * Seeds the update check Codex caches in `$CODEX_HOME/version.json`, so the next Codex
 * started from that home offers `latestVersion`, and reads back any dismissal (PRD §12;
 * docs/cli-behavior.md, "Codex 0.171.0 update offer"). Codex offers it when it is newer
 * than the running binary, no dismissal names it, and the check is recent.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeCodexUpdateCheck(home: string, latestVersion: string): void {
  writeFileSync(
    join(home, "version.json"),
    JSON.stringify({
      latest_version: latestVersion,
      last_checked_at: new Date().toISOString(),
      dismissed_version: null,
    }),
  );
}

/**
 * The version a Codex dismissal named in `home`, or null. `Skip until next version` sets
 * one. Codex writes the key either way, so a missing key or another value is an error.
 */
export function readCodexDismissedVersion(home: string): string | null {
  const check: unknown = JSON.parse(readFileSync(join(home, "version.json"), "utf8"));
  if (typeof check !== "object" || check === null || !("dismissed_version" in check))
    throw new Error("Codex's version.json names no dismissed_version");
  const dismissed = check.dismissed_version;
  if (dismissed === null || typeof dismissed === "string") return dismissed;
  throw new Error(`Codex's version.json names dismissed_version ${JSON.stringify(dismissed)}`);
}
