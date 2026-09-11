/**
 * Unit tests for the probe-owned temp state directory (C-API-41 cleanup).
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ownedProbeStateDir } from "../../src/core/models/probe-state.ts";

describe("ownedProbeStateDir", () => {
  test("C-API-41 creates a fresh owned dir under a parent and removes exactly it", () => {
    const parent = mkdtempSync(join(tmpdir(), "elwood-probe-parent-"));
    const state = ownedProbeStateDir("claude", parent);
    expect(state.dir.startsWith(parent)).toBe(true);
    expect(existsSync(state.dir)).toBe(true);
    state.remove();
    expect(existsSync(state.dir)).toBe(false);
    // Only the probe's own subdir was removed; the caller's parent is untouched.
    expect(existsSync(parent)).toBe(true);
  });

  test("C-API-41 creates a NON-existent caller stateDir before placing the owned dir", () => {
    const parent = join(
      mkdtempSync(join(tmpdir(), "elwood-probe-")),
      "does",
      "not",
      "exist",
      "yet",
    );
    expect(existsSync(parent)).toBe(false);
    const state = ownedProbeStateDir("codex", parent);
    expect(existsSync(state.dir)).toBe(true);
    expect(readdirSync(parent)).toHaveLength(1);
    state.remove();
  });

  test("C-API-41 falls back to the OS temp dir when no parent is given", () => {
    const state = ownedProbeStateDir("claude");
    expect(state.dir.startsWith(tmpdir())).toBe(true);
    state.remove();
    expect(existsSync(state.dir)).toBe(false);
  });

  test("C-API-41 remove() is a silent no-op on an already-gone directory", () => {
    const state = ownedProbeStateDir("claude");
    state.remove();
    expect(() => state.remove()).not.toThrow(); // `force` ignores the missing dir
  });

  test("C-API-41 remove() swallows a real fs error so cleanup never throws", () => {
    // Replace the owned dir's PARENT with a file: rmSync on the owned path then throws
    // ENOTDIR even with `force`; best-effort cleanup must swallow it, not surface it.
    const parent = join(mkdtempSync(join(tmpdir(), "elwood-probe-")), "parent");
    const state = ownedProbeStateDir("claude", parent);
    rmSync(parent, { recursive: true, force: true });
    writeFileSync(parent, "not a directory");
    expect(() => state.remove()).not.toThrow();
  });
});
