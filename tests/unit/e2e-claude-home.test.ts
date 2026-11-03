/**
 * The e2e suite's private Claude config dir (`tests/e2e/claude-home.ts`, PRD §12,
 * C-E2E-23). Each case loads the module in a child process, the way the e2e runner does,
 * with a fake user config dir, and checks what the private dir held and what is left once
 * that process exits: a login without its refresh token, the global config without its
 * project entries, MCP servers, or bypass acceptance, the model catalog, no user settings,
 * and afterwards nothing but the user's own files, unchanged. No case reads the real
 * keychain: each child reads an empty fake one (`fake-keychain.ts`).
 */

import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  childClaudeHome,
  parseSeen,
  runChild,
  type Seen,
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
    expect(seen.claudeTemp.startsWith(join(tmp, "elwood_e2e_ctmp-"))).toBe(true);
    expect(seen).toMatchObject({ claudeTempEnv: seen.claudeTemp, claudeTempEmpty: true });
    expect(readdirSync(tmp)).toEqual([]); // both private dirs removed at exit
    expect(tree(user)).toEqual(before);
  });

  test("C-E2E-23 a worker reads the user's setting, not the private dir it inherits", () => {
    const tmp = tempDir("claude-home-worker-");
    const user = tempDir("claude-home-user-");
    userConfig(user);
    const runner = tempDir("claude-home-runner-"); // the runner's own private dir
    writeFileSync(join(runner, ".claude.json"), "{}");
    const runnerTemp = tempDir("claude-home-runner-tmp-"); // the runner's own Claude temp root
    writeFileSync(join(runnerTemp, "kept"), "");
    const env = { TMPDIR: tmp, CLAUDE_CONFIG_DIR: runner, CLAUDE_CODE_TMPDIR: runnerTemp };
    const custom = childClaudeHome({
      ...env,
      HOME: home(),
      ELWOOD_E2E_USER_CLAUDE_CONFIG_DIR: user,
    });
    expect(custom).toMatchObject({ user, config: JSON.stringify(seeded) });
    expect(custom.dir).not.toBe(runner);
    expect(custom.claudeTempEnv).toBe(custom.claudeTemp);
    expect(custom.claudeTemp).not.toBe(runnerTemp);
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
    expect(tree(runnerTemp)).toEqual({ kept: "" });
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

  test("C-E2E-23 a global config that is not JSON is named without its contents", () => {
    const tmp = tempDir("claude-home-bad-config-");
    const user = tempDir("claude-home-user-");
    writeFileSync(join(user, ".claude.json"), "SECRET-NOT-JSON");
    const malformed = runChild({ TMPDIR: tmp, HOME: home(), CLAUDE_CONFIG_DIR: user });
    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toContain(`${join(user, ".claude.json")} is not JSON`);
    expect(malformed.stderr).not.toContain("SECRET-NOT-JSON");
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("C-E2E-23 a global config that cannot be read fails as the read, not as malformed JSON", () => {
    const tmp = tempDir("claude-home-unreadable-");
    const user = tempDir("claude-home-user-");
    mkdirSync(join(user, ".claude.json")); // a directory: reading it fails with EISDIR
    const unreadable = runChild({ TMPDIR: tmp, HOME: home(), CLAUDE_CONFIG_DIR: user });
    expect(unreadable.status).not.toBe(0);
    expect(unreadable.stderr).toContain("EISDIR");
    expect(unreadable.stderr).not.toContain("is not JSON");
    expect(readdirSync(tmp)).toEqual([]);
  });

  const report = {
    dir: "/t/d",
    env: "/t/d",
    user: "/u",
    global: "/u/.claude.json",
    entries: [".claude.json"],
    credentials: null,
    credentialsMode: null,
    config: "{}",
    catalog: null,
    storage: null,
    claudeTemp: "/t/c",
    claudeTempEnv: "/t/c",
    claudeTempEmpty: true,
  } satisfies Seen;

  test("C-E2E-23 the harness reads the child's report only in the shape it declares", () => {
    expect(parseSeen(JSON.stringify(report))).toEqual(report);
    expect(() => parseSeen("[]")).toThrow("claude-home child reported no object");
    for (const [key, value] of [
      ["dir", null],
      ["entries", [1]],
      ["entries", null],
      ["credentials", 1],
      ["credentialsMode", "0600"],
      ["storage", 1],
      ["claudeTemp", null],
      ["claudeTempEnv", 1],
      ["claudeTempEmpty", "yes"],
    ] as const)
      expect(() => parseSeen(JSON.stringify({ ...report, [key]: value }))).toThrow(
        `claude-home child reported a malformed ${key}`,
      );
  });
});
