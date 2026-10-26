/**
 * Child-process harness for the e2e Claude config dir tests (`tests/e2e/claude-home.ts`,
 * PRD §12, C-E2E-23): loads the module in a fresh process, the way the e2e runner does,
 * and reports what its private dir held; plus a fake user config dir to seed it from.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isRecord, isString, isStringArray } from "../../src/core/predicates.ts";

const claudeHomeModule = resolve(import.meta.dirname, "../e2e/claude-home.ts");

export type Seen = {
  readonly dir: string;
  readonly env: string;
  readonly user: string;
  readonly global: string;
  readonly entries: readonly string[];
  readonly credentials: string | null;
  readonly credentialsMode: number | null;
  readonly config: string | null;
  readonly catalog: string | null;
};

const script = `
  import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
  import { join } from "node:path";
  const m = await import(${JSON.stringify(claudeHomeModule)});
  const dir = m.defaultClaudeConfigDir;
  const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null);
  const login = join(dir, ".credentials.json");
  console.log(JSON.stringify({
    dir, env: process.env.CLAUDE_CONFIG_DIR, user: m.userConfigDir, global: m.userGlobalConfig,
    entries: readdirSync(dir).sort(),
    credentials: read(".credentials.json"),
    credentialsMode: existsSync(login) ? statSync(login).mode & 0o777 : null,
    config: read(".claude.json"),
    catalog: read("cache/model-catalog/catalog.json"),
  }));`;

/** A child process that loads the module with `env` over a clean Claude environment. */
export function runChild(env: Readonly<Record<string, string>>) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv["ELWOOD_E2E_USER_CLAUDE_CONFIG_DIR"];
  delete childEnv["CLAUDE_CONFIG_DIR"];
  Object.assign(childEnv, env);
  return spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], {
    env: childEnv,
    encoding: "utf8",
  });
}

/** What a child process that loads the module saw in its private dir, given `env`. */
export function childClaudeHome(env: Readonly<Record<string, string>>): Seen {
  const run = runChild(env);
  if (run.status !== 0) throw new Error(`claude-home child exited ${run.status}: ${run.stderr}`);
  return parseSeen(run.stdout);
}

/** The child's report, checked field by field against `Seen`. */
export function parseSeen(text: string): Seen {
  const report: unknown = JSON.parse(text);
  if (!isRecord(report)) throw new Error("claude-home child reported no object");
  const field = <T>(key: keyof Seen, valid: (value: unknown) => value is T): T => {
    const value = report[key];
    if (!valid(value)) throw new Error(`claude-home child reported a malformed ${key}`);
    return value;
  };
  const isStringOrNull = (value: unknown): value is string | null =>
    value === null || isString(value);
  return {
    dir: field("dir", isString),
    env: field("env", isString),
    user: field("user", isString),
    global: field("global", isString),
    entries: field("entries", isStringArray),
    credentials: field("credentials", isStringOrNull),
    credentialsMode: field(
      "credentialsMode",
      (value): value is number | null => value === null || typeof value === "number",
    ),
    config: field("config", isStringOrNull),
    catalog: field("catalog", isStringOrNull),
  };
}

/** Every file under `dir` with its contents, to show a dir is unchanged. */
export function tree(dir: string): Readonly<Record<string, string>> {
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
  return Object.fromEntries(
    files
      .filter((name) => statSync(join(dir, name)).isFile())
      .map((name) => [name, readFileSync(join(dir, name), "utf8")]),
  );
}

const login = {
  claudeAiOauth: {
    accessToken: "access",
    expiresAt: 1,
    refreshToken: "refresh",
    refreshTokenExpiresAt: 2,
    scopes: ["user:inference"],
  },
  mcpOAuth: { server: { accessToken: "mcp" } },
};
export const seeded = { theme: "dark", hasCompletedOnboarding: true };

/** A user Claude config dir with a login, a global config, settings, and a catalog. */
export function userConfig(dir: string, globalConfig = join(dir, ".claude.json")): void {
  mkdirSync(join(dir, "cache", "model-catalog"), { recursive: true });
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify(login));
  writeFileSync(
    globalConfig,
    JSON.stringify({
      projects: { "/work": {} },
      mcpServers: { s: {} },
      bypassPermissionsModeAccepted: true,
      theme: "dark",
    }),
  );
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "opus" }));
  writeFileSync(join(dir, "cache", "model-catalog", "catalog.json"), "[]");
}
