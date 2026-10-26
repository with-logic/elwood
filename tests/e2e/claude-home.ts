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
 * - `.credentials.json` (0600): the user's Claude login, from their own `.credentials.json`
 *   or the macOS keychain, without its refresh token (`claude-login.ts`). It lasts as long
 *   as the access token, so each process copies it afresh.
 * - `.claude.json`: the user's global config without `projects` (one entry per directory
 *   Claude ever ran in), `mcpServers`, or `bypassPermissionsModeAccepted`, so first-run
 *   screens and notices the user has already dismissed stay dismissed, no user MCP server
 *   starts, and the bypass-permissions dialog always renders for the e2e to answer.
 * - `cache/model-catalog/`: the served model catalog, so the model picker lists it without
 *   racing its first fetch (`claude-compiled-fallback.ts`).
 */

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../src/core/predicates.ts";
import { privateTempDir } from "../helpers/private-temp.ts";
import { accessOnlyLogin, keychainLogin } from "./claude-login.ts";

/**
 * Carries the user's own `CLAUDE_CONFIG_DIR` ("" when unset) into `node --test` workers,
 * which inherit the private one in its place.
 */
const userSettingKey = "ELWOOD_E2E_USER_CLAUDE_CONFIG_DIR";
const userSetting = process.env[userSettingKey] ?? process.env["CLAUDE_CONFIG_DIR"] ?? "";
process.env[userSettingKey] = userSetting;

/**
 * Whether the user's Claude takes its config from `CLAUDE_CONFIG_DIR`. Claude then keeps
 * the global config inside that dir and its login under a keychain item of its own, even
 * when the dir is `~/.claude`.
 */
const customUserConfigDir = userSetting !== "";

/** The config dir the user's own Claude resolves: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export const userConfigDir = userSetting || join(homedir(), ".claude");

/** The user's global config: in the config dir when one is set, else `~/.claude.json`. */
export const userGlobalConfig = customUserConfigDir
  ? join(userConfigDir, ".claude.json")
  : join(homedir(), ".claude.json");

/** The user's login JSON: their plaintext credentials file, else the default keychain item. */
function userCredentials(): string | undefined {
  const file = join(userConfigDir, ".credentials.json");
  if (existsSync(file)) return readFileSync(file, "utf8");
  // A custom config dir's keychain item is not the default one: not read here.
  return platform() !== "darwin" || customUserConfigDir ? undefined : keychainLogin();
}

/** The user's global config without its per-project entries, MCP servers, or bypass acceptance. */
function seededGlobalConfig(): string {
  if (!existsSync(userGlobalConfig)) return JSON.stringify({ hasCompletedOnboarding: true });
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(userGlobalConfig, "utf8"));
  } catch {
    throw new Error(`${userGlobalConfig} is not JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${userGlobalConfig} does not hold a JSON object`);
  const {
    projects: _projects,
    mcpServers: _mcp,
    bypassPermissionsModeAccepted: _accepted,
    ...rest
  } = parsed;
  return JSON.stringify({ ...rest, hasCompletedOnboarding: true });
}

/**
 * This process's `CLAUDE_CONFIG_DIR`, never at or inside the user's own config dir. Its
 * removal is registered before anything is copied in, so a failed copy leaves nothing
 * behind. The prefix does not start with `elwood-`, which socket homes use
 * (`src/state/socket-home.ts`).
 */
export const defaultClaudeConfigDir = privateTempDir(
  "elwood_e2e_claude_config-",
  userConfigDir,
  "Claude config dir",
);
process.on("exit", () => rmSync(defaultClaudeConfigDir, { recursive: true, force: true }));
const login = userCredentials();
const access = login === undefined ? undefined : accessOnlyLogin(login, "The user's Claude login");
if (access !== undefined)
  writeFileSync(join(defaultClaudeConfigDir, ".credentials.json"), access, { mode: 0o600 });
writeFileSync(join(defaultClaudeConfigDir, ".claude.json"), seededGlobalConfig(), { mode: 0o600 });
const catalog = join(userConfigDir, "cache", "model-catalog");
if (existsSync(catalog))
  cpSync(catalog, join(defaultClaudeConfigDir, "cache", "model-catalog"), { recursive: true });
process.env["CLAUDE_CONFIG_DIR"] = defaultClaudeConfigDir;
