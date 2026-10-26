/**
 * The default Claude config dir for every real-Claude e2e (PRD §12, C-E2E-23). Like
 * `codex-home.ts`, `npm run test:e2e` loads this module before any test (`--import`), and
 * the shared e2e helpers import it, so a file run on its own gets it too. It points
 * `CLAUDE_CONFIG_DIR` at a private directory and removes it when the process exits. What
 * Claude persists while the suite drives it — the global config's entry for each scratch
 * project, transcripts under `projects/`, prompt history, shell snapshots — lands there,
 * never in the user's `~/.claude.json` or `~/.claude/`, which are only read.
 *
 * The private dir starts with three copies:
 * - `.credentials.json` (0600): the user's Claude login, from the macOS keychain or their
 *   own `.credentials.json`, with the refresh token removed. Claude reads this file when its
 *   config dir has no keychain entry. Without the refresh token the copy can never rotate,
 *   and so invalidate, the user's own login; it lasts as long as the access token, so each
 *   process copies it afresh. MCP OAuth tokens are left out.
 * - `.claude.json`: the user's global config without `projects` (one entry per directory
 *   Claude ever ran in), `mcpServers`, or `bypassPermissionsModeAccepted`, so first-run
 *   screens and notices the user has already dismissed stay dismissed, no user MCP server
 *   starts, and the bypass-permissions dialog always renders for the e2e to answer.
 * - `cache/model-catalog/`: the served model catalog, so the model picker lists it without
 *   racing its first fetch (`claude-compiled-fallback.ts`).
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

/** Carries the user's own Claude config dir into `node --test` workers, which inherit the sandbox. */
const userConfigDirKey = "ELWOOD_E2E_USER_CLAUDE_CONFIG_DIR";

/** Where Claude keeps its state when `CLAUDE_CONFIG_DIR` is unset. */
const defaultUserConfigDir = join(homedir(), ".claude");

/** The config dir the user's own Claude resolves: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export const userConfigDir =
  process.env[userConfigDirKey] || process.env["CLAUDE_CONFIG_DIR"] || defaultUserConfigDir;
process.env[userConfigDirKey] = userConfigDir;
const customUserConfigDir = userConfigDir !== defaultUserConfigDir;

/** Claude keeps its global config in the config dir only when one is set, else in `~`. */
export const userGlobalConfig = customUserConfigDir
  ? join(userConfigDir, ".claude.json")
  : join(homedir(), ".claude.json");

/** The user's login JSON: their plaintext credentials file, else the default keychain item. */
function userCredentials(): string | undefined {
  const file = join(userConfigDir, ".credentials.json");
  if (existsSync(file)) return readFileSync(file, "utf8");
  // A custom config dir's keychain item is named after a hash of its path: not read here.
  if (platform() !== "darwin" || customUserConfigDir) return undefined;
  const result = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    { encoding: "utf8", timeout: 5_000 },
  );
  return result.status === 0 ? result.stdout : undefined;
}

/** The login without anything that could rotate the user's own tokens. */
function accessOnly(credentials: string): string | undefined {
  const parsed: unknown = JSON.parse(credentials);
  const oauth = (parsed as { claudeAiOauth?: Record<string, unknown> } | null)?.claudeAiOauth;
  if (typeof oauth !== "object" || oauth === null) return undefined;
  const { refreshToken: _refresh, refreshTokenExpiresAt: _expires, ...access } = oauth;
  return JSON.stringify({ claudeAiOauth: access });
}

/** The user's global config without its per-project entries, MCP servers, or bypass acceptance. */
function seededGlobalConfig(): string {
  const parsed: unknown = existsSync(userGlobalConfig)
    ? JSON.parse(readFileSync(userGlobalConfig, "utf8"))
    : {};
  const {
    projects: _projects,
    mcpServers: _mcp,
    bypassPermissionsModeAccepted: _accepted,
    ...rest
  } = (parsed ?? {}) as Record<string, unknown>;
  return JSON.stringify({ ...rest, hasCompletedOnboarding: true });
}

/**
 * This process's `CLAUDE_CONFIG_DIR`. Its removal is registered before anything is copied
 * in, so a failed copy leaves nothing behind. The prefix does not start with `elwood-`,
 * which socket homes use (`src/state/socket-home.ts`).
 */
export const defaultClaudeConfigDir = mkdtempSync(join(tmpdir(), "elwood_e2e_claude_config-"));
process.on("exit", () => rmSync(defaultClaudeConfigDir, { recursive: true, force: true }));
const login = userCredentials();
const access = login === undefined ? undefined : accessOnly(login);
if (access !== undefined)
  writeFileSync(join(defaultClaudeConfigDir, ".credentials.json"), access, { mode: 0o600 });
writeFileSync(join(defaultClaudeConfigDir, ".claude.json"), seededGlobalConfig(), { mode: 0o600 });
const catalog = join(userConfigDir, "cache", "model-catalog");
if (existsSync(catalog))
  cpSync(catalog, join(defaultClaudeConfigDir, "cache", "model-catalog"), { recursive: true });
process.env["CLAUDE_CONFIG_DIR"] = defaultClaudeConfigDir;
