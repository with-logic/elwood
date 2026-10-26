/**
 * A Claude project hook that records which Anthropic credential variables Claude's own
 * environment holds, by name only (PRD §12, C-E2E-23). An invalid `ANTHROPIC_API_KEY` keeps
 * Claude from `ready`, but an invalid `ANTHROPIC_AUTH_TOKEN` does not, so `ready` alone cannot
 * show that Claude got neither. A `SessionStart` hook runs with Claude's environment.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "../../src/runtime/shell.ts";
import { anthropicCredentialVariables } from "./claude-login.ts";

/**
 * Claude's hook timeout, in seconds as Claude reads it. The hook runs two shell tests and one
 * `mv`; the bound only keeps a stalled hook from holding Claude's startup.
 */
const credentialHookTimeoutSeconds = 30;

/**
 * Adds the hook to the project at `cwd` and returns the file it writes once, whole: the
 * names of the credential variables Claude's environment sets, one per line.
 */
export function recordCredentialVariables(cwd: string): string {
  const record = join(cwd, "credential-variables");
  const partial = `${record}.partial`;
  // A parameter test, not `printenv`: no command runs, so none can fail and pass for unset.
  const checks = anthropicCredentialVariables
    .map((name) => `if [ "\${${name}+set}" = set ]; then echo ${name}; fi`)
    .join("; ");
  const command = `{ ${checks}; } > ${shellQuote(partial)} && mv ${shellQuote(partial)} ${shellQuote(record)}`;
  const hook = [{ hooks: [{ type: "command", command, timeout: credentialHookTimeoutSeconds }] }];
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(
    join(cwd, ".claude", "settings.json"),
    JSON.stringify({ hooks: { SessionStart: hook } }),
  );
  return record;
}

/** The names the hook recorded, or undefined before it has written `record`. */
export function recordedVariables(record: string): readonly string[] | undefined {
  if (!existsSync(record)) return undefined;
  return readFileSync(record, "utf8").split("\n").filter(Boolean);
}
