/**
 * The e2e suite's private Claude config dir (`tests/e2e/claude-home.ts`, PRD §12,
 * C-E2E-23). Each case loads the module in a child process, the way the e2e runner does,
 * with a fake user config dir, and checks what the private dir held and what is left once
 * that process exits: a login without its refresh token, the global config without its
 * project entries, MCP servers, or bypass acceptance, the model catalog, no user settings,
 * and afterwards nothing but the user's own files, unchanged. No case reads the real
 * keychain: each gives the child a `.credentials.json` or a custom config dir, which skip it.
 */

import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  childClaudeHome,
  runChild,
  seeded,
  tree,
  userConfig,
} from "../helpers/claude-home-child.ts";
import { tempDir } from "../helpers/tmp.ts";

const home = () => tempDir("claude-home-home-");

describe("e2e Claude config dir (C-E2E-23)", () => {
  test("C-E2E-23 seeds a private dir without a refresh token and removes only it at exit", () => {
    const tmp = tempDir("claude-home-own-");
    const user = tempDir("claude-home-user-");
    userConfig(user);
    const before = tree(user);
    const seen = childClaudeHome({ TMPDIR: tmp, HOME: home(), CLAUDE_CONFIG_DIR: user });
    expect(seen.dir.startsWith(join(tmp, "elwood_e2e_claude_config-"))).toBe(true);
    expect(seen).toMatchObject({ env: seen.dir, user, global: join(user, ".claude.json") });
    expect(JSON.parse(seen.credentials ?? "")).toEqual({
      claudeAiOauth: { accessToken: "access", expiresAt: 1, scopes: ["user:inference"] },
    });
    expect(seen.credentialsMode).toBe(0o600);
    expect(JSON.parse(seen.config ?? "")).toEqual(seeded);
    expect(seen.catalog).toBe("[]");
    expect(seen.entries).toEqual([".claude.json", ".credentials.json", "cache"]); // no settings
    expect(readdirSync(tmp)).toEqual([]);
    expect(tree(user)).toEqual(before);
  });

  test("C-E2E-23 a worker reads the user's setting, not the private dir it inherits", () => {
    const tmp = tempDir("claude-home-worker-");
    const user = tempDir("claude-home-user-");
    userConfig(user);
    const runner = tempDir("claude-home-runner-"); // the runner's own private dir
    writeFileSync(join(runner, ".claude.json"), "{}");
    const env = { TMPDIR: tmp, CLAUDE_CONFIG_DIR: runner };
    const custom = childClaudeHome({
      ...env,
      HOME: home(),
      ELWOOD_E2E_USER_CLAUDE_CONFIG_DIR: user,
    });
    expect(custom).toMatchObject({ user, config: JSON.stringify(seeded) });
    expect(custom.dir).not.toBe(runner);
    const userHome = home(); // the user had no CLAUDE_CONFIG_DIR: ~/.claude, not the runner's
    userConfig(join(userHome, ".claude"), join(userHome, ".claude.json"));
    const unset = childClaudeHome({
      ...env,
      HOME: userHome,
      ELWOOD_E2E_USER_CLAUDE_CONFIG_DIR: "",
    });
    expect(unset).toMatchObject({
      user: join(userHome, ".claude"),
      config: JSON.stringify(seeded),
    });
    expect(tree(runner)).toEqual({ ".claude.json": "{}" });
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("C-E2E-23 an empty or missing user config dir seeds no login and removes nothing", () => {
    const tmp = tempDir("claude-home-missing-");
    const missing = join(tempDir("claude-home-parent-"), "gone");
    const empty = tempDir("claude-home-empty-");
    for (const user of [missing, empty]) {
      const seen = childClaudeHome({ TMPDIR: tmp, HOME: home(), CLAUDE_CONFIG_DIR: user });
      expect(seen).toMatchObject({ user, credentials: null, catalog: null });
      expect(JSON.parse(seen.config ?? "")).toEqual({ hasCompletedOnboarding: true });
    }
    expect(() => statSync(missing)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(readdirSync(empty)).toEqual([]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("C-E2E-23 an empty CLAUDE_CONFIG_DIR is unset; one naming ~/.claude is still a setting", () => {
    const tmp = tempDir("claude-home-default-");
    const userHome = home();
    userConfig(join(userHome, ".claude"), join(userHome, ".claude.json"));
    const before = tree(userHome);
    const unset = childClaudeHome({ TMPDIR: tmp, HOME: userHome, CLAUDE_CONFIG_DIR: "" });
    expect(unset).toMatchObject({
      user: join(userHome, ".claude"),
      global: join(userHome, ".claude.json"),
    });
    expect(JSON.parse(unset.config ?? "")).toEqual(seeded);
    // Set to ~/.claude, Claude reads the global config inside it, which this user lacks.
    const explicit = childClaudeHome({
      TMPDIR: tmp,
      HOME: userHome,
      CLAUDE_CONFIG_DIR: join(userHome, ".claude"),
    });
    expect(explicit.global).toBe(join(userHome, ".claude", ".claude.json"));
    expect(JSON.parse(explicit.config ?? "")).toEqual({ hasCompletedOnboarding: true });
    expect(tree(userHome)).toEqual(before);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("C-E2E-23 refuses a TMPDIR inside the user's config dir, and names a malformed file without its contents", () => {
    const user = tempDir("claude-home-user-");
    userConfig(user);
    const inside = join(user, "tmp");
    mkdirSync(inside);
    const refused = runChild({ TMPDIR: inside, HOME: home(), CLAUDE_CONFIG_DIR: user });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("TMPDIR is inside the user's Claude config dir");
    expect(readdirSync(inside)).toEqual([]);
    const tmp = tempDir("claude-home-malformed-");
    writeFileSync(join(user, ".credentials.json"), "SECRET-NOT-JSON");
    const malformed = runChild({ TMPDIR: tmp, HOME: home(), CLAUDE_CONFIG_DIR: user });
    expect(malformed.stderr).toContain("The user's Claude login is not JSON");
    expect(malformed.stderr).not.toContain("SECRET-NOT-JSON");
    expect(readdirSync(tmp)).toEqual([]); // the exit handler still removed the private dir
  });
});
