/**
 * The user's Claude login, and the copy of it an e2e Claude config dir may hold (PRD §12,
 * C-E2E-23). Claude reads `$CLAUDE_CONFIG_DIR/.credentials.json` when its config dir has
 * no keychain entry. A copy without the refresh token cannot refresh, so it can never
 * rotate, and so invalidate, the login the user's own Claude sessions keep using. It
 * lasts as long as the access token. MCP OAuth tokens are left out. Errors name the
 * source, never its contents.
 */

import { spawnSync } from "node:child_process";
import { isRecord } from "../../src/core/predicates.ts";

/** How long a keychain read may take before the e2e setup gives up on it. */
export const keychainTimeoutMs = 5_000;

/** `security`'s exit status when the keychain holds no such item. */
const itemNotFound = 44;

/**
 * The JSON of the keychain item Claude keeps its login in when `CLAUDE_CONFIG_DIR` is
 * unset, or undefined when there is no such item. Throws when the keychain cannot be read.
 */
export function keychainLogin(): string | undefined {
  const result = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    { encoding: "utf8", timeout: keychainTimeoutMs },
  );
  if (result.status === itemNotFound) return undefined;
  if (result.error === undefined && result.status === 0) return result.stdout;
  const reason = result.error
    ? ((result.error as NodeJS.ErrnoException).code ?? result.error.name)
    : `security exited ${result.status ?? result.signal}`;
  throw new Error(`Could not read the Claude login from the macOS keychain (${reason})`);
}

/**
 * `credentials` reduced to its Claude login without the refresh token, or undefined when
 * it holds no Claude login: no `claudeAiOauth` record with a non-empty access token. Throws
 * when it is not JSON; `source` names it in the error.
 */
export function accessOnlyLogin(credentials: string, source: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credentials);
  } catch {
    throw new Error(`${source} is not JSON`);
  }
  const oauth = isRecord(parsed) ? parsed["claudeAiOauth"] : undefined;
  if (!isRecord(oauth)) return undefined;
  const accessToken = oauth["accessToken"];
  if (typeof accessToken !== "string" || accessToken === "") return undefined;
  const { refreshToken: _refresh, refreshTokenExpiresAt: _expires, ...access } = oauth;
  return JSON.stringify({ claudeAiOauth: access });
}
