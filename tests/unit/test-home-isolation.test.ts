/**
 * The Vitest preload gives each test file a private `HOME` and `CODEX_HOME` (PRD §12), so
 * code that resolves the user's Codex home from them cannot reach the developer's own
 * `~/.codex`, even after a test unsets `CODEX_HOME`. `userInfo()` reads the account
 * database, not `HOME`, so it still names the developer's real home. Both suites create
 * those homes with `privateTempDir`, which refuses a `TMPDIR` inside the user's Codex home.
 * The e2e suite removes them at exit with `removeOrReport`, which removes only a directory
 * `privateTempDir` created.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { privateTempDir, removeOrReport } from "../helpers/private-temp.ts";

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

describe("removeOrReport", () => {
  const roots: string[] = [];
  let exitCode: typeof process.exitCode;
  /** A `privateTempDir` directory under a scratch TMPDIR, and the lines reported. */
  function scratch() {
    const root = mkdtempSync(join(tmpdir(), "private-temp-"));
    roots.push(root);
    vi.stubEnv("TMPDIR", root);
    return { root, dir: privateTempDir("home-", join(root, "codex")), lines: [] as string[] };
  }

  beforeEach(() => {
    exitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = exitCode;
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) {
      chmodSync(root, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("removes a directory privateTempDir created, then finds nothing left to remove", () => {
    const { dir, lines } = scratch();
    writeFileSync(join(dir, "state"), "");
    removeOrReport(dir, "home", (line) => lines.push(line));
    expect(existsSync(dir)).toBe(false);
    removeOrReport(dir, "home", (line) => lines.push(line));
    expect(lines).toEqual([]);
    expect(process.exitCode).toBe(exitCode);
  });

  test("removes nothing for an empty path or one privateTempDir did not create, and fails", () => {
    const { root, dir, lines } = scratch();
    const other = join(root, "other");
    mkdirSync(other);
    for (const path of ["", other, `${dir}/`]) removeOrReport(path, "home", (l) => lines.push(l));
    expect([existsSync(other), existsSync(dir)]).toEqual([true, true]);
    expect(lines).toEqual(
      ["", other, `${dir}/`].map(
        (path) =>
          `Could not clean up the e2e home ${JSON.stringify(path)}: privateTempDir did not create it\n`,
      ),
    );
    expect(process.exitCode).toBe(1);
  });

  test("reports a removal that fails, and a later removal still runs", () => {
    const { root, dir, lines } = scratch();
    const kept = privateTempDir("kept-", join(root, "codex"));
    writeFileSync(join(kept, "state"), "");
    chmodSync(root, 0o500); // the directories under it cannot be removed
    removeOrReport(kept, "kept home", (line) => lines.push(line));
    chmodSync(root, 0o700);
    removeOrReport(dir, "home", (line) => lines.push(line));
    expect([existsSync(kept), existsSync(dir)]).toEqual([true, false]);
    expect(lines).toEqual([
      expect.stringMatching(/^Could not clean up the e2e kept home .*EACCES/),
    ]);
    expect(process.exitCode).toBe(1);
  });

  test("a report that throws still fails the run", () => {
    removeOrReport("", "home", () => {
      throw new Error("stderr is closed");
    });
    expect(process.exitCode).toBe(1);
  });
});
