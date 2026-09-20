/** Identify each fake PTY's permanently bound runtime artifacts (C-API-20). */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { PtySpawnOptions } from "../../src/pty/types.ts";

export function launchArtifactPaths(options: PtySpawnOptions, sessionDir: string) {
  const command = options.args.join(" ");
  const launchId = /(?:hook-bridge|claude-settings)-([0-9a-f-]+)\.(?:mjs|json)/.exec(command)?.[1];
  if (!launchId) throw new Error("PTY launch did not bind a private bridge artifact.");
  return {
    bridge: join(sessionDir, `hook-bridge-${launchId}.mjs`),
    settings: join(sessionDir, `claude-settings-${launchId}.json`),
  };
}

/** Fresh-start fixtures have exactly one artifact; ambiguity is a test setup error. */
export function onlyLaunchArtifact(sessionDir: string, prefix: string): string {
  const matches = readdirSync(sessionDir).filter((name) => name.startsWith(`${prefix}-`));
  if (matches.length !== 1)
    throw new Error(`Expected one ${prefix} artifact, found ${matches.length}`);
  return join(sessionDir, matches[0]!);
}
