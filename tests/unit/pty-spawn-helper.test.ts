/**
 * node-pty `spawn-helper` executable-bit repair (PRD §4.1): restored only when
 * missing, never rewritten when already executable, tolerated when the install is
 * read-only, and skipped when absent. `chmodSync` is observed through a module mock
 * so the "untouched" and "read-only" cases are provable rather than inferred.
 */

import { chmodSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { tempDir } from "../helpers/tmp.ts";

const observed = vi.hoisted(() => ({ chmods: [] as string[], denyChmod: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    chmodSync: (path: Parameters<typeof actual.chmodSync>[0], mode: number) => {
      observed.chmods.push(String(path));
      if (observed.denyChmod) throw Object.assign(new Error("read-only"), { code: "EPERM" });
      return actual.chmodSync(path, mode);
    },
  };
});

// The shared preload already loaded `pty/node.ts` against the real `node:fs`, so the
// module registry is reset and the subject re-imported AFTER the mock is registered.
vi.resetModules();
const { ensureNodePtySpawnHelperExecutable } = await import("../../src/pty/node.ts");

function helperAt(mode: number): string {
  const path = join(tempDir("elwood-spawn-helper-"), "spawn-helper");
  writeFileSync(path, "");
  chmodSync(path, mode);
  observed.chmods.length = 0;
  observed.denyChmod = false;
  return path;
}

describe("ensureNodePtySpawnHelperExecutable", () => {
  test("restores a missing execute bit", () => {
    const helper = helperAt(0o644);
    ensureNodePtySpawnHelperExecutable(helper);
    expect(statSync(helper).mode & 0o111).toBeGreaterThan(0);
    expect(observed.chmods).toEqual([helper]);
  });

  test("leaves an already-executable helper untouched (no write into node_modules)", () => {
    const helper = helperAt(0o755);
    ensureNodePtySpawnHelperExecutable(helper);
    expect(observed.chmods).toEqual([]);
  });

  test("tolerates a chmod failure on a read-only install", () => {
    const helper = helperAt(0o644);
    observed.denyChmod = true;
    expect(() => ensureNodePtySpawnHelperExecutable(helper)).not.toThrow();
    expect(statSync(helper).mode & 0o111).toBe(0); // unrepaired, and node-pty reports it
  });

  test("skips an absent helper without touching the filesystem", () => {
    observed.chmods.length = 0;
    const missing = join(tempDir("elwood-spawn-helper-"), "missing-helper");
    expect(() => ensureNodePtySpawnHelperExecutable(missing)).not.toThrow();
    expect(observed.chmods).toEqual([]);
  });
});
