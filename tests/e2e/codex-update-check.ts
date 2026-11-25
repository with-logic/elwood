/**
 * Seeds the update check Codex caches in `$CODEX_HOME/version.json`, so the next Codex
 * started from that home offers `latestVersion` (PRD §12; docs/cli-behavior.md, "Codex
 * 0.171.0 update offer"). Codex offers it when it is newer than the running binary, no
 * dismissal names it, and the check is recent.
 */

import { writeFileSync } from "node:fs";
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
