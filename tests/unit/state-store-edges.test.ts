/**
 * Unit coverage for state store file-operation edge cases (PRD §8.2, §8.4, §10,
 * C-ERR-04, C-STATE-03, C-STATE-08). Filesystem failures are injected through a
 * `node:fs` mock keyed on path substrings so no test depends on chmod tricks.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { fsyncDir, writePrivateFileAtomic } from "../../src/state/files.ts";
import {
  createSessionRecord,
  prepareStateDir,
  readSessionRecord,
  removeSessionFiles,
  sessionDir,
  writeSessionRecord,
} from "../../src/state/store.ts";
import { tempDir } from "../helpers/tmp.ts";

// Failures are keyed on path substrings so every other filesystem write is untouched
// (mocks are hoisted above imports by vitest). `rmSync` throws a bare STRING for the
// raw-remove dir so the store's `String(error)` normalization is exercised.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    rmSync: (path: string, options?: Parameters<typeof actual.rmSync>[1]) => {
      if (typeof path === "string" && path.includes("raw-remove"))
        throwPrimitive("raw remove failure");
      if (typeof path === "string" && path.includes("err-remove"))
        throw new Error("EPERM remove failure");
      return actual.rmSync(path, options);
    },
    renameSync: (from: string, to: string) => {
      if (to.includes("rename-fails")) throw new Error("EXDEV rename failure");
      return actual.renameSync(from, to);
    },
  };
});

describe("state store edges", () => {
  test("C-ERR-04 stringifies non-Error read failures as corrupt-state causes", () => {
    const root = tempDir("elwood-validate-");
    const record = createSessionRecord({ cwd: root, id: "raw-read" });
    writeSessionRecord(record, sessionDir(root, "raw-read"));
    const spy = vi
      .spyOn(JSON, "parse")
      .mockImplementationOnce(() => throwPrimitive("raw parse failure"));
    let caught: unknown;
    try {
      readSessionRecord(root, "raw-read");
    } catch (error) {
      caught = error;
    }
    spy.mockRestore();
    expect(caught).toMatchObject({
      code: "state_corrupt",
      details: { cause: "raw parse failure" },
    });
  });

  test("C-STATE-08 stringifies non-Error failures while removing session files", () => {
    const root = tempDir("elwood-validate-");
    const record = createSessionRecord({ cwd: root, id: "raw-remove" });
    const dir = sessionDir(root, "raw-remove");
    writeSessionRecord(record, dir);
    let caught: unknown;
    try {
      removeSessionFiles({
        stateDir: root,
        elwoodSessionId: "raw-remove",
        socketHome: "/tmp/x",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "teardown_failed",
      details: { cause: "raw remove failure", sessionDir: dir },
    });
  });

  test("C-STATE-08 surfaces an Error failure's message while removing session files", () => {
    const root = tempDir("elwood-validate-");
    const record = createSessionRecord({ cwd: root, id: "err-remove" });
    const dir = sessionDir(root, "err-remove");
    writeSessionRecord(record, dir);
    let caught: unknown;
    try {
      removeSessionFiles({
        stateDir: root,
        elwoodSessionId: "err-remove",
        socketHome: "/tmp/x",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "teardown_failed",
      details: { cause: "EPERM remove failure", sessionDir: dir },
    });
  });

  test("§8.4 a socket-home removal FAILURE still removes the session dir, then reports teardown_failed", () => {
    // The two removals are independent (attempt-all): a socket-home rmSync failure must
    // NOT prevent the session-directory removal that would otherwise leave resumable
    // metadata + runtime files behind.
    const root = tempDir("elwood-validate-");
    prepareStateDir(root);
    const dir = sessionDir(root, "attempt-all");
    writeSessionRecord(createSessionRecord({ cwd: root, id: "attempt-all" }), dir);
    const socketHome = join(root, "elwood-err-remove-home"); // owned prefix; rmSync throws
    expect(() =>
      removeSessionFiles({ stateDir: root, elwoodSessionId: "attempt-all", socketHome }),
    ).toThrow(/Could not remove/);
    expect(existsSync(dir)).toBe(false); // the session dir was STILL removed
  });

  test("C-STATE-03 a failed atomic write leaves no temp file behind and keeps the old content", () => {
    const root = tempDir("elwood-validate-");
    const path = join(root, "rename-fails.json");
    writeFileSync(path, "before", { mode: 0o600 });
    expect(() => writePrivateFileAtomic(path, "after")).toThrow(/EXDEV/);
    expect(readFileSync(path, "utf8")).toBe("before");
    expect(readdirSync(root)).toEqual(["rename-fails.json"]); // the .tmp-* file was unlinked
  });

  test("C-STATE-03 fsyncDir ignores missing directories", () => {
    const root = tempDir("elwood-validate-");
    expect(() => fsyncDir(join(root, "missing"))).not.toThrow();
  });
});

function throwPrimitive(value: string): never {
  throw value; // a bare string exercises non-Error failure normalization
}
