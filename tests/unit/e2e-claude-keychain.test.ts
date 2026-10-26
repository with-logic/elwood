/**
 * Where the e2e suite's private Claude config dir gets the user's login (`tests/e2e/
 * claude-home.ts`, `claude-login.ts`, PRD §12, C-E2E-23): from where the user's own Claude
 * reads it. On macOS that is the keychain item Claude names for the user's settings, which it
 * prefers to a credentials file. The naming cases call `claude-login.ts` directly; the
 * platform cases load `claude-home.ts` in a child process whose keychain is a fake one
 * (`fake-keychain.ts`).
 */

import { readdirSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { keychainService, keychainStorageSetting } from "../e2e/claude-login.ts";
import { childClaudeHome, login, runChild, userConfig } from "../helpers/claude-home-child.ts";
import { fakeKeychain } from "../helpers/fake-keychain.ts";
import { tempDir } from "../helpers/tmp.ts";

/** `login` as the private dir holds it: without its refresh token or MCP tokens. */
const accessOnly = { accessToken: "access", expiresAt: 1, scopes: ["user:inference"] };
const onMac = platform() === "darwin";

describe("C-E2E-23 the keychain item Claude reads for a config dir", () => {
  test("is the default item when CLAUDE_CONFIG_DIR is unset or empty", () => {
    expect(keychainService("")).toBe("Claude Code-credentials");
  });

  test("is named by the setting's hash when it is set", () => {
    // The name claude 2.1.310 read with CLAUDE_CONFIG_DIR=/tmp/etl-kc.IWLLlS.
    expect(keychainService("/tmp/etl-kc.IWLLlS")).toBe("Claude Code-credentials-fb1cf458");
    // Claude hashes the setting NFC-normalized, as written.
    expect(keychainService("/u/café")).toBe(keychainService("/u/café"));
    expect(keychainService("/u/.claude")).not.toBe(keychainService("/u/.claude/"));
  });

  test("is named for CLAUDE_SECURESTORAGE_CONFIG_DIR when it is set, even empty", () => {
    expect(keychainStorageSetting("/s", "/c")).toBe("/s");
    expect(keychainStorageSetting("", "/c")).toBe("");
    expect(keychainStorageSetting(undefined, "/c")).toBe("/c");
  });
});

describe.skipIf(!onMac)("C-E2E-23 on macOS the private dir copies the login", () => {
  test("from a set config dir's own keychain item", () => {
    const user = tempDir("claude-keychain-user-");
    const keychain = fakeKeychain({ service: keychainService(user), login: JSON.stringify(login) });
    const env = { TMPDIR: tempDir("claude-keychain-tmp-"), HOME: tempDir("claude-keychain-home-") };
    const seen = childClaudeHome({
      ...env,
      CLAUDE_CONFIG_DIR: user,
      ELWOOD_E2E_SECURITY_BIN: keychain.bin,
    });
    expect(JSON.parse(seen.credentials ?? "")).toEqual({ claudeAiOauth: accessOnly });
    expect(keychain.lookups()).toEqual([keychainService(user)]);
  });

  test("from the keychain item before the credentials file, as Claude does", () => {
    const user = tempDir("claude-keychain-user-");
    userConfig(user); // a credentials file holding the access token "access"
    const item = { claudeAiOauth: { ...login.claudeAiOauth, accessToken: "from-keychain" } };
    const keychain = fakeKeychain({ service: keychainService(user), login: JSON.stringify(item) });
    const env = { TMPDIR: tempDir("claude-keychain-tmp-"), HOME: tempDir("claude-keychain-home-") };
    const seen = childClaudeHome({
      ...env,
      CLAUDE_CONFIG_DIR: user,
      ELWOOD_E2E_SECURITY_BIN: keychain.bin,
    });
    expect(JSON.parse(seen.credentials ?? "")).toEqual({
      claudeAiOauth: { ...accessOnly, accessToken: "from-keychain" },
    });
  });

  test("from the default item when CLAUDE_CONFIG_DIR is unset, and the file without an item", () => {
    const keychain = fakeKeychain();
    const userHome = tempDir("claude-keychain-home-");
    userConfig(join(userHome, ".claude"), join(userHome, ".claude.json"));
    const env = { TMPDIR: tempDir("claude-keychain-tmp-"), HOME: userHome };
    const seen = childClaudeHome({
      ...env,
      CLAUDE_CONFIG_DIR: "",
      ELWOOD_E2E_SECURITY_BIN: keychain.bin,
    });
    expect(keychain.lookups()).toEqual(["Claude Code-credentials"]);
    expect(JSON.parse(seen.credentials ?? "")).toEqual({ claudeAiOauth: accessOnly });
  });

  test.each([
    ["unset", undefined],
    ["empty", ""],
  ])("from the default item when CLAUDE_CONFIG_DIR is %s", (_case, setting) => {
    const item = { claudeAiOauth: { ...login.claudeAiOauth, accessToken: "from-default" } };
    const service = "Claude Code-credentials";
    const keychain = fakeKeychain({ service, login: JSON.stringify(item) });
    const env = { TMPDIR: tempDir("claude-keychain-tmp-"), HOME: tempDir("claude-keychain-home-") };
    const seen = childClaudeHome({
      ...env,
      ...(setting === undefined ? {} : { CLAUDE_CONFIG_DIR: setting }),
      ELWOOD_E2E_SECURITY_BIN: keychain.bin,
    });
    expect(JSON.parse(seen.credentials ?? "")).toEqual({
      claudeAiOauth: { ...accessOnly, accessToken: "from-default" },
    });
    expect(keychain.lookups()).toEqual([service]);
  });

  test("from CLAUDE_SECURESTORAGE_CONFIG_DIR's item, and keeps that variable from its Claudes", () => {
    const user = tempDir("claude-keychain-user-");
    const storage = tempDir("claude-keychain-storage-");
    const keychain = fakeKeychain({
      service: keychainService(storage),
      login: JSON.stringify(login),
    });
    const env = { TMPDIR: tempDir("claude-keychain-tmp-"), HOME: tempDir("claude-keychain-home-") };
    const seen = childClaudeHome({
      ...env,
      CLAUDE_CONFIG_DIR: user,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: storage,
      ELWOOD_E2E_SECURITY_BIN: keychain.bin,
    });
    expect(JSON.parse(seen.credentials ?? "")).toEqual({ claudeAiOauth: accessOnly });
    expect(keychain.lookups()).toEqual([keychainService(storage)]);
    expect(seen.storage).toBeNull(); // the suite's Claudes name their item for the private dir
  });

  test("and fails, leaving nothing, when the keychain cannot be read", () => {
    const user = tempDir("claude-keychain-user-");
    const tmp = tempDir("claude-keychain-tmp-");
    const keychain = fakeKeychain({ service: keychainService(user), status: 51 });
    const env = { TMPDIR: tmp, HOME: tempDir("claude-keychain-home-") };
    const failed = runChild({
      ...env,
      CLAUDE_CONFIG_DIR: user,
      ELWOOD_E2E_SECURITY_BIN: keychain.bin,
    });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain(
      "Could not read the Claude login from the macOS keychain (security exited 51)",
    );
    expect(readdirSync(tmp)).toEqual([]); // the exit handler removed the private dir
  });
});

describe.skipIf(onMac)("C-E2E-23 off macOS the private dir copies the login", () => {
  test("from the credentials file, and never looks in a keychain", () => {
    const user = tempDir("claude-keychain-user-");
    userConfig(user);
    const keychain = fakeKeychain({ service: keychainService(user), login: "{}" });
    const env = { TMPDIR: tempDir("claude-keychain-tmp-"), HOME: tempDir("claude-keychain-home-") };
    const seen = childClaudeHome({
      ...env,
      CLAUDE_CONFIG_DIR: user,
      ELWOOD_E2E_SECURITY_BIN: keychain.bin,
    });
    expect(JSON.parse(seen.credentials ?? "")).toEqual({ claudeAiOauth: accessOnly });
    expect(keychain.lookups()).toEqual([]);
  });
});
