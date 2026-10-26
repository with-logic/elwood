/**
 * The parent Claude state the native question proof must leave alone (PRD §12, C-E2E-18).
 * The default config dir's settings, hooks, and keychain login must not change. Its global
 * config is rewritten all the time by Claude sessions outside the proof, so only its project
 * entries are checked, for any that name the proof's private paths.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isRecord } from "../../../src/core/predicates.ts";
import { claudeProjectKeys, projectKeysWithin } from "../claude-projects.ts";
import { parentFileFingerprint } from "../parent-file-fingerprint.ts";

/** The parent's global config: `~/.claude.json` for the default config dir. */
export function parentGlobalConfig(): string {
  return join(homedir(), ".claude.json");
}

/** The parent global config, which must hold a JSON object. */
export function parentConfiguration(): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(readFileSync(parentGlobalConfig(), "utf8"));
  if (!isRecord(parsed)) throw new Error("Parent Claude configuration must be a JSON object");
  return parsed;
}

/**
 * The user's own `CLAUDE_CONFIG_DIR` setting, "" when unset. The e2e runner keeps it in
 * `ELWOOD_E2E_USER_CLAUDE_CONFIG_DIR` (`claude-home.ts`) and points `CLAUDE_CONFIG_DIR` at
 * its private dir.
 */
export function userConfigDirSetting(): string {
  return process.env["ELWOOD_E2E_USER_CLAUDE_CONFIG_DIR"] ?? process.env["CLAUDE_CONFIG_DIR"] ?? "";
}

/** Fingerprints of the parent's settings, hooks, and keychain login `credential`. */
export function parentFingerprint(credential: string): Readonly<Record<string, string>> {
  const paths = [".claude/settings.json", ".claude/hooks.json"];
  return Object.fromEntries([
    ["keychain", createHash("sha256").update(credential).digest("hex")],
    ...paths.map((name) => [name, parentFileFingerprint(join(homedir(), name))]),
  ]);
}

/**
 * Throws when the parent's settings, hooks, or login `credential` differ from `before`, or
 * when its global config has a project entry for the private `root` or a path inside it.
 */
export function assertParentUnchanged(
  before: Readonly<Record<string, string>>,
  credential: string,
  root: string,
): void {
  const after = parentFingerprint(credential);
  const changed = Object.keys(before).filter((name) => before[name] !== after[name]);
  if (changed.length) throw new Error(`Parent Claude configuration changed: ${changed.join(", ")}`);
  const keys = claudeProjectKeys(parentConfiguration(), "Parent Claude configuration");
  // `root` is resolved; Claude may also record the temp dir's unresolved spelling.
  const privateProjectKeys = projectKeysWithin(keys, [root, join(tmpdir(), basename(root))]);
  if (privateProjectKeys.length)
    throw new Error(
      `Parent Claude global config names the private root: ${privateProjectKeys.join(", ")}`,
    );
}
