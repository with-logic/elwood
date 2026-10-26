/**
 * The default Claude config dir for every real-Claude e2e (PRD §12, C-E2E-23). Like
 * `codex-home.ts`, `npm run test:e2e` loads this module before any test (`--import`), and
 * the shared e2e helpers import it, so a file run on its own gets it too. It points
 * `CLAUDE_CONFIG_DIR` at a private directory and removes it when the process exits. What
 * Claude persists while the suite drives it — the global config's entry for each scratch
 * project, transcripts under `projects/`, prompt history, shell snapshots — lands there,
 * never in the user's `~/.claude.json` or `~/.claude/`, which are only read. It also points
 * `CLAUDE_CODE_TMPDIR`, Claude's temp root, at a second private directory it removes at exit.
 *
 * The private dir starts with three copies:
 * - `.credentials.json` (0600): the user's Claude login, from their own `.credentials.json`
 *   or, on macOS, the keychain item for their config dir, without its refresh token
 *   (`claude-login.ts`). It lasts as long
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
import {
  accessOnlyLogin,
  keychainLogin,
  keychainService,
  keychainStorageSetting,
} from "./claude-login.ts";
import { registerPrivateHome } from "./home-guard.ts";

/**
 * Carries the user's own `CLAUDE_CONFIG_DIR` ("" when unset) into `node --test` workers,
 * which inherit the private one in its place.
 */
const userSettingKey = "ELWOOD_E2E_USER_CLAUDE_CONFIG_DIR";
const userSetting = process.env[userSettingKey] ?? process.env["CLAUDE_CONFIG_DIR"] ?? "";
process.env[userSettingKey] = userSetting;

/**
 * Carries the setting the user's own Claude names its keychain item for
 * (`keychainStorageSetting`) into workers. `CLAUDE_SECURESTORAGE_CONFIG_DIR` itself is
 * removed, so each Claude the suite starts names its item for the private dir, which has
 * none, and reads the private dir's credentials file, never the user's item.
 */
const userStorageKey = "ELWOOD_E2E_USER_CLAUDE_STORAGE_SETTING";
const userStorageSetting =
  process.env[userStorageKey] ??
  keychainStorageSetting(process.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"], userSetting);
process.env[userStorageKey] = userStorageSetting;
delete process.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"];

/**
 * Whether the user has `CLAUDE_CONFIG_DIR` set, to any dir. Claude then keeps the global
 * config inside that dir and its login under a keychain item of its own, even when the dir
 * is `~/.claude`.
 */
const hasUserConfigDirSetting = userSetting !== "";

/** The config dir the user's own Claude resolves: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export const userConfigDir = userSetting || join(homedir(), ".claude");

/** The user's global config: in the config dir when one is set, else `~/.claude.json`. */
export const userGlobalConfig = hasUserConfigDirSetting
  ? join(userConfigDir, ".claude.json")
  : join(homedir(), ".claude.json");

/**
 * The user's login JSON, from where the user's own Claude reads it. On macOS that is the
 * keychain item Claude names for their settings, set or not, and their credentials file only
 * when there is no such item. Elsewhere it is the credentials file.
 */
function userCredentials(): string | undefined {
  const item =
    platform() === "darwin" ? keychainLogin(keychainService(userStorageSetting)) : undefined;
  if (item !== undefined) return item;
  const file = join(userConfigDir, ".credentials.json");
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/** The user's global config without its per-project entries, MCP servers, or bypass acceptance. */
function seededGlobalConfig(): string {
  if (!existsSync(userGlobalConfig)) return JSON.stringify({ hasCompletedOnboarding: true });
  // A read failure throws as itself; only a parse failure is the file not being JSON.
  const text = readFileSync(userGlobalConfig, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
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
registerPrivateHome(defaultClaudeConfigDir);
process.env["CLAUDE_CONFIG_DIR"] = defaultClaudeConfigDir;

/** The variable naming the directory Claude keeps its temp root in, `/tmp` when unset. */
export const claudeTempKey = "CLAUDE_CODE_TMPDIR";

/**
 * This process's `CLAUDE_CODE_TMPDIR`, removed when it exits. Claude keeps a directory per
 * working directory under its temp root, holding each session's scratchpad, and that
 * directory outlives the session; under the shared `/tmp`, each scratch project would leave
 * one behind. The prefix is short because Claude puts its messaging socket at
 * `<root>/cc-socks/<pid>.sock` only while that path fits a socket address.
 */
export const defaultClaudeTempDir = privateTempDir(
  "elwood_e2e_ctmp-",
  userConfigDir,
  "Claude config dir",
);
process.on("exit", () => rmSync(defaultClaudeTempDir, { recursive: true, force: true }));
process.env[claudeTempKey] = defaultClaudeTempDir;
