/**
 * The Vitest preload gives each test file a private `HOME` and `CODEX_HOME` (PRD §12), so
 * code that resolves the user's Codex home from them cannot reach the developer's own
 * `~/.codex`, even after a test unsets `CODEX_HOME`. `userInfo()` reads the account
 * database, not `HOME`, so it still names the developer's real home. Both suites create
 * those homes with `privateTempDir`, which refuses a `TMPDIR` inside the user's Codex home.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { privateTempDir } from "../helpers/private-temp.ts";

const realHome = userInfo().homedir;

test("HOME is a private directory, not the developer's home", () => {
  expect(homedir()).not.toBe(realHome);
  expect(homedir().startsWith(`${realHome}/`)).toBe(false);
});

test("CODEX_HOME is the private home's .codex, so unsetting it falls back to the same place", () => {
  expect(process.env["CODEX_HOME"]).toBe(join(homedir(), ".codex"));
});

describe("privateTempDir", () => {
  const roots: string[] = [];
  /** A scratch dir holding a stand-in user Codex home at `<root>/codex`. */
  function scratch() {
    const root = mkdtempSync(join(tmpdir(), "private-temp-"));
    roots.push(root);
    const codexHome = join(root, "codex");
    mkdirSync(join(codexHome, "tmp"), { recursive: true });
    return { root, codexHome };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("refuses a TMPDIR at or inside the user's Codex home", () => {
    const { codexHome } = scratch();
    for (const temp of [codexHome, join(codexHome, "tmp")]) {
      vi.stubEnv("TMPDIR", temp);
      expect(() => privateTempDir("home-", codexHome)).toThrow(/inside the user's Codex home/);
    }
  });

  test("creates the home beside a Codex home whose name its TMPDIR shares", () => {
    const { root, codexHome } = scratch();
    const sibling = join(root, "codex-tmp");
    mkdirSync(sibling);
    vi.stubEnv("TMPDIR", sibling);
    const home = privateTempDir("home-", codexHome);
    expect(home.startsWith(join(sibling, "home-"))).toBe(true);
    expect(existsSync(home)).toBe(true);
  });

  test("compares a Codex home that does not exist yet as given", () => {
    const { root } = scratch();
    vi.stubEnv("TMPDIR", root);
    expect(() => privateTempDir("home-", join(root, "missing"))).not.toThrow();
    expect(() => privateTempDir("home-", root)).toThrow(/inside the user's Codex home/);
  });
});
