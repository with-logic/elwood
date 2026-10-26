/**
 * The e2e suite's private Claude config dir (`tests/e2e/claude-home.ts`, PRD §12,
 * C-E2E-23). Each case loads the module in a child process, the way the e2e runner does,
 * with a fake user config dir, and checks what the private dir held and what is left once
 * that process exits: a login without its refresh token, the global config without its
 * project entries or MCP servers, the model catalog, no user settings, and afterwards
 * nothing but the user's own files, unchanged. No case reads the real keychain: each
 * gives the child a `.credentials.json` or a custom config dir, which skip it.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "../helpers/tmp.ts";

const claudeHomeModule = resolve(import.meta.dirname, "../e2e/claude-home.ts");

type Seen = {
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

/** What a child process that loads the module saw in its private dir, given `env`. */
function childClaudeHome(env: Readonly<Record<string, string>>): Seen {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv["ELWOOD_E2E_USER_CLAUDE_CONFIG_DIR"];
  delete childEnv["CLAUDE_CONFIG_DIR"];
  Object.assign(childEnv, env);
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
  const run = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], {
    env: childEnv,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`claude-home child exited ${run.status}: ${run.stderr}`);
  return JSON.parse(run.stdout) as Seen;
}

/** Every file under `dir` with its contents, to show a dir is unchanged. */
function tree(dir: string): Readonly<Record<string, string>> {
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

/** A user Claude config dir with a login, a global config, settings, and a catalog. */
function userConfig(dir: string): void {
  mkdirSync(join(dir, "cache", "model-catalog"), { recursive: true });
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify(login));
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({ projects: { "/work": {} }, mcpServers: { s: {} }, theme: "dark" }),
  );
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "opus" }));
  writeFileSync(join(dir, "cache", "model-catalog", "catalog.json"), "[]");
}

describe("e2e Claude config dir (C-E2E-23)", () => {
  test("C-E2E-23 seeds a private dir without a refresh token and removes only it at exit", () => {
    const tmp = tempDir("claude-home-own-");
    const user = tempDir("claude-home-user-");
    userConfig(user);
    const before = tree(user);
    const seen = childClaudeHome({
      TMPDIR: tmp,
      HOME: tempDir("claude-home-home-"),
      CLAUDE_CONFIG_DIR: user,
    });
    expect(seen.dir.startsWith(join(tmp, "elwood_e2e_claude_config-"))).toBe(true);
    expect(seen).toMatchObject({ env: seen.dir, user, global: join(user, ".claude.json") });
    expect(JSON.parse(seen.credentials ?? "")).toEqual({
      claudeAiOauth: { accessToken: "access", expiresAt: 1, scopes: ["user:inference"] },
    });
    expect(seen.credentialsMode).toBe(0o600);
    expect(JSON.parse(seen.config ?? "")).toEqual({ theme: "dark", hasCompletedOnboarding: true });
    expect(seen.catalog).toBe("[]");
    expect(seen.entries).toEqual([".claude.json", ".credentials.json", "cache"]); // no settings
    expect(readdirSync(tmp)).toEqual([]);
    expect(tree(user)).toEqual(before);
  });

  test("C-E2E-23 a worker reads the user's config dir, not the sandbox it inherits", () => {
    const tmp = tempDir("claude-home-worker-");
    const user = tempDir("claude-home-user-");
    userConfig(user);
    const runner = tempDir("claude-home-runner-"); // the runner's own private dir
    writeFileSync(join(runner, ".claude.json"), "{}");
    const seen = childClaudeHome({
      TMPDIR: tmp,
      HOME: tempDir("claude-home-home-"),
      CLAUDE_CONFIG_DIR: runner,
      ELWOOD_E2E_USER_CLAUDE_CONFIG_DIR: user,
    });
    expect(seen.user).toBe(user);
    expect(seen.dir).not.toBe(runner);
    expect(JSON.parse(seen.config ?? "")).toEqual({ theme: "dark", hasCompletedOnboarding: true });
    expect(tree(runner)).toEqual({ ".claude.json": "{}" });
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("C-E2E-23 an empty or missing user config dir seeds no login and removes nothing", () => {
    const tmp = tempDir("claude-home-missing-");
    const missing = join(tempDir("claude-home-parent-"), "gone");
    const absent = childClaudeHome({
      TMPDIR: tmp,
      HOME: tempDir("claude-home-home-"),
      CLAUDE_CONFIG_DIR: missing,
    });
    expect(absent).toMatchObject({ user: missing, credentials: null, catalog: null });
    expect(JSON.parse(absent.config ?? "")).toEqual({ hasCompletedOnboarding: true });
    expect(() => statSync(missing)).toThrow(expect.objectContaining({ code: "ENOENT" }));

    // An empty CLAUDE_CONFIG_DIR is unset: the user's dir is ~/.claude, their config ~/.claude.json.
    const home = tempDir("claude-home-home-");
    userConfig(join(home, ".claude"));
    const before = tree(home);
    const empty = childClaudeHome({ TMPDIR: tmp, HOME: home, CLAUDE_CONFIG_DIR: "" });
    expect(empty).toMatchObject({
      user: join(home, ".claude"),
      global: join(home, ".claude.json"),
    });
    expect(JSON.parse(empty.config ?? "")).toEqual({ hasCompletedOnboarding: true });
    expect(tree(home)).toEqual(before);
    expect(readdirSync(tmp)).toEqual([]);
  });
});
