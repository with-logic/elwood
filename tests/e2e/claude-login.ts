/**
 * The user's Claude login, and the copy of it an e2e Claude config dir may hold (PRD §12,
 * C-E2E-23). On macOS Claude keeps its login in a keychain item named for its config dir
 * (`keychainService`), and reads `$CLAUDE_CONFIG_DIR/.credentials.json` when that item does
 * not exist. A copy without the refresh token cannot refresh, so it can never
 * rotate, and so invalidate, the login the user's own Claude sessions keep using. It
 * lasts as long as the access token. MCP OAuth tokens are left out. Errors name the
 * source, never its contents.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isRecord } from "../../src/core/predicates.ts";

/** The variables that log Claude in on their own, whatever its config dir holds. */
export const anthropicCredentialVariables = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/** How long a keychain read may take before the e2e setup gives up on it. */
export const keychainTimeoutMs = 5_000;

/** `security`'s exit status when the keychain holds no such item. */
const itemNotFound = 44;

/** The keychain item Claude keeps its login in when `CLAUDE_CONFIG_DIR` is unset. */
const defaultService = "Claude Code-credentials";

/**
 * The setting Claude names its keychain item for: `CLAUDE_SECURESTORAGE_CONFIG_DIR` when it
 * is set, even to "", else the `CLAUDE_CONFIG_DIR` setting ("" when unset). Read from claude
 * 2.1.310.
 */
export function keychainStorageSetting(
  secureStorageSetting: string | undefined,
  configDirSetting: string,
): string {
  return secureStorageSetting ?? configDirSetting;
}

/**
 * The keychain item Claude keeps its login in for `storageSetting` (`keychainStorageSetting`;
 * "" when unset, as Claude treats an empty one). A set dir's item carries the first eight hex
 * digits of the SHA-256 of the setting as written, NFC-normalized, even when it names
 * `~/.claude`. Read from claude 2.1.310, and checked against it: with `CLAUDE_CONFIG_DIR` set,
 * Claude reported itself logged in exactly while an item of this name existed.
 */
export function keychainService(storageSetting: string): string {
  if (storageSetting === "") return defaultService;
  const digest = createHash("sha256").update(storageSetting.normalize("NFC")).digest("hex");
  return `${defaultService}-${digest.slice(0, 8)}`;
}

/**
 * The `security` executable the keychain is read with. `ELWOOD_E2E_SECURITY_BIN` replaces it
 * in the harness's own tests, so they never read the user's keychain.
 */
const securityBin = () => process.env["ELWOOD_E2E_SECURITY_BIN"] ?? "/usr/bin/security";

/**
 * The JSON of the keychain item `service` (`keychainService`), or undefined when there is
 * no such item. Throws when the keychain cannot be read.
 */
export function keychainLogin(service = defaultService): string | undefined {
  const result = spawnSync(securityBin(), ["find-generic-password", "-s", service, "-w"], {
    encoding: "utf8",
    timeout: keychainTimeoutMs,
  });
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
